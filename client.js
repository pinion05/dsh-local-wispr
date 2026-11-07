/**
 * Local Wispr — client half.
 *
 * Adds one microphone button to the composer tool row (slot
 * `conversation.input.right`). Click to record from the browser microphone;
 * click again (or the stop button) to finish, Escape to cancel. The recording
 * is POSTed to this plugin's same-origin host route, which forwards it to the
 * local Whisper gateway; the returned transcript is inserted into the draft
 * at the captured caret through InputActions (revision-guarded, with a fresh
 * caret retry). No browser speech API, no external service, no settings UI.
 */
window.__ModuleLoader__.load({
	id: "@local/dsh-local-wispr",
	factory(require) {
		const React = require("react");
		const h = React.createElement;

		const NS = "local-wispr";
		const MAX_SECONDS = 240; // pi-voice-board rejects > 300 s; stop well before.
		const MIME_CANDIDATES = [
			"audio/webm;codecs=opus",
			"audio/webm",
			"audio/ogg;codecs=opus",
			"audio/mp4"
		];

		const DICT = {
			ko: {
				record: "음성 입력 (로컬 Whisper) — 클릭하여 녹음",
				stop: "녹음 종료하고 전사 (Escape: 취소)",
				cancel: "취소 (Escape)",
				recording: "녹음 중",
				transcribing: "전사 중…",
				denied: "마이크 권한이 없습니다 — 브라우저 주소창에서 허용해 주세요",
				insecure: "HTTPS 필요 — 마이크는 HTTPS(또는 localhost)에서만 사용할 수 있습니다",
				noRecorder: "이 브라우저는 MediaRecorder를 지원하지 않습니다",
				failed: "전사 실패",
				empty: "인식된 음성이 없습니다"
			},
			en: {
				record: "Voice input (local Whisper) — click to record",
				stop: "Stop and transcribe (Escape: cancel)",
				cancel: "Cancel (Escape)",
				recording: "Recording",
				transcribing: "Transcribing…",
				denied: "Microphone permission denied — allow it in the browser bar",
				insecure: "HTTPS required — microphone needs HTTPS (or localhost)",
				noRecorder: "This browser does not support MediaRecorder",
				failed: "Transcription failed",
				empty: "No speech recognized"
			}
		};

		function MicIcon() {
			return h("svg", {
				width: 16, height: 16, viewBox: "0 0 24 24", "aria-hidden": true,
				fill: "none", stroke: "currentColor", strokeWidth: 2,
				strokeLinecap: "round", strokeLinejoin: "round"
			},
			h("rect", { x: 9, y: 2.5, width: 6, height: 11, rx: 3, fill: "currentColor", stroke: "none" }),
			h("path", { d: "M5 11a7 7 0 0 0 14 0" }),
			h("path", { d: "M12 18v3.5" }),
			h("path", { d: "M8.5 21.5h7" }));
		}

		function StopIcon() {
			return h("svg", {
				width: 16, height: 16, viewBox: "0 0 24 24", "aria-hidden": true
			},
			h("rect", { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2.5, fill: "currentColor" }));
		}

		function SlotStyles() {
			return h("style", null, `
.lw-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;
	border:none;border-radius:8px;background:transparent;cursor:pointer;
	color:var(--dsw-alias-label-secondary);white-space:nowrap}
.lw-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.lw-btn:disabled{opacity:.45;cursor:default}
.lw-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.lw-dot{width:9px;height:9px;border-radius:50%;flex:none;
	background:var(--dsw-alias-state-error-primary);animation:lw-pulse 1.1s ease-in-out infinite}
@keyframes lw-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.8)}}
.lw-time{font:11px/1 var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);
	color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.lw-spin{width:12px;height:12px;border-radius:50%;flex:none;
	border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);
	animation:lw-rotate .8s linear infinite}
@keyframes lw-rotate{to{transform:rotate(360deg)}}
.lw-err{color:var(--dsw-alias-state-error-primary)}
.lw-why{max-width:min(52vw,340px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
	font:11px/1 var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}
`);
		}

		function fmtClock(totalSeconds) {
			const s = Math.max(0, Math.floor(totalSeconds));
			return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
		}

		function pickMime() {
			if (typeof MediaRecorder === "undefined") return "";
			for (const mime of MIME_CANDIDATES) {
				try {
					if (MediaRecorder.isTypeSupported(mime)) return mime;
				} catch {
					/* keep probing */
				}
			}
			return "";
		}

		function VoiceButton({ inputActions, t }) {
			const [state, setState] = React.useState("idle"); // idle | starting | recording | transcribing | error
			const [elapsed, setElapsed] = React.useState(0);
			const [errorText, setErrorText] = React.useState("");
			const runtime = React.useRef({
				stream: null,
				recorder: null,
				chunks: [],
				mime: "",
				timer: 0,
				startedAt: 0,
				span: null,
				cancelled: false,
				fetchController: null,
				keyHandler: null
			});

			const releaseCapture = React.useCallback(() => {
				const rt = runtime.current;
				if (rt.timer) {
					clearInterval(rt.timer);
					rt.timer = 0;
				}
				if (rt.recorder && rt.recorder.state !== "inactive") {
					try {
						rt.recorder.stop();
					} catch {
						/* already stopped */
					}
				}
				rt.recorder = null;
				if (rt.stream) {
					for (const track of rt.stream.getTracks()) track.stop();
					rt.stream = null;
				}
				if (rt.keyHandler) {
					document.removeEventListener("keydown", rt.keyHandler);
					rt.keyHandler = null;
				}
			}, []);

			React.useEffect(() => releaseCapture, [releaseCapture]);

			const fail = React.useCallback((message) => {
				releaseCapture();
				setState("error");
				setErrorText(message);
				setTimeout(() => {
					setState((current) => (current === "error" ? "idle" : current));
				}, 3500);
			}, [releaseCapture]);

			const cancel = React.useCallback(() => {
				const rt = runtime.current;
				rt.cancelled = true;
				if (rt.fetchController) rt.fetchController.abort();
				releaseCapture();
				setState("idle");
				setElapsed(0);
			}, [releaseCapture]);

			const transcribe = React.useCallback(async (blob) => {
				const rt = runtime.current;
				rt.fetchController = new AbortController();
				try {
					const response = await fetch("/local-wispr/transcribe", {
						method: "POST",
						headers: { "content-type": blob.type || "audio/webm" },
						body: blob,
						signal: rt.fetchController.signal
					});
					const data = await response.json().catch(() => ({}));
					if (!response.ok || typeof data.text !== "string") {
						throw new Error(data.error || `HTTP ${response.status}`);
					}
					const text = data.text.trim();
					if (!text) {
						fail(`${t("empty")}`);
						return;
					}
					let inserted = false;
					if (inputActions && typeof inputActions.insertText === "function") {
						const span = rt.span;
						if (span) inserted = inputActions.insertText(text, span);
						if (!inserted) {
							try {
								inserted = inputActions.insertText(text, inputActions.captureInsertion());
							} catch {
								inserted = false;
							}
						}
					} else {
						console.warn("[local-wispr] inputActions unavailable; transcript dropped", text);
					}
					if (!inserted) console.warn("[local-wispr] draft insertion refused; transcript dropped", text);
					setState("idle");
					setElapsed(0);
				} catch (error) {
					if (error?.name === "AbortError") return; // cancelled meanwhile
					fail(`${t("failed")}: ${String(error?.message ?? error)}`);
				} finally {
					rt.fetchController = null;
				}
			}, [inputActions, t, fail]);

			const finish = React.useCallback(() => {
				const rt = runtime.current;
				if (rt.recorder && rt.recorder.state !== "inactive") {
					rt.recorder.stop(); // onstop assembles the blob and transcribes
					return;
				}
				// Recorder already gone (auto-stop race): flush what we have.
				const chunks = rt.chunks;
				const mime = rt.mime;
				releaseCapture();
				if (chunks.length === 0) {
					setState("idle");
					return;
				}
				setState("transcribing");
				transcribe(new Blob(chunks, { type: mime || "audio/webm" }));
			}, [releaseCapture, transcribe]);

			const start = React.useCallback(async () => {
				if (typeof MediaRecorder === "undefined") {
					fail(t("noRecorder"));
					return;
				}
				const rt = runtime.current;
				rt.cancelled = false;
				rt.chunks = [];
				rt.span = null;
				setState("starting");
				try {
					if (inputActions && typeof inputActions.captureInsertion === "function") {
						try {
							rt.span = inputActions.captureInsertion();
						} catch {
							rt.span = null;
						}
					}
					if (!window.isSecureContext || !navigator.mediaDevices) {
					// Origin first: on mobile the reason is truncated from the tail,
					// so the offending address must lead the message to be visible.
					fail(`${location.origin} ← ${t("insecure")}`);
					return;
				}
				const stream = await navigator.mediaDevices.getUserMedia({
						audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
					});
					if (rt.cancelled) {
						for (const track of stream.getTracks()) track.stop();
						setState("idle");
						return;
					}
					rt.stream = stream;
					const mime = pickMime();
					rt.mime = mime ? mime.split(";")[0] : "audio/webm";
					const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
					rt.recorder = recorder;
					recorder.ondataavailable = (event) => {
						if (event.data && event.data.size > 0) rt.chunks.push(event.data);
					};
					recorder.onstop = () => {
						const chunks = rt.chunks;
						const blobType = rt.mime;
						releaseCapture();
						if (rt.cancelled) {
							setState("idle");
							setElapsed(0);
							return;
						}
						if (chunks.length === 0) {
							fail(t("empty"));
							return;
						}
						setState("transcribing");
						transcribe(new Blob(chunks, { type: blobType }));
					};
					try {
						recorder.start(250);
					} catch {
						recorder.start(); // older Safari rejects timeslice; one final chunk still arrives before onstop
					}
					rt.startedAt = Date.now();
					setElapsed(0);
					setState("recording");
					rt.timer = setInterval(() => {
						const seconds = (Date.now() - rt.startedAt) / 1000;
						setElapsed(seconds);
						if (seconds >= MAX_SECONDS) finish();
					}, 250);
					rt.keyHandler = (event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
							cancel();
						}
					};
					document.addEventListener("keydown", rt.keyHandler, true);
				} catch (error) {
					if (rt.cancelled) {
						setState("idle");
						return;
					}
					const name = error?.name || "";
					fail(name === "NotAllowedError" || name === "SecurityError" ? t("denied") : `${t("failed")}: ${String(error?.message ?? error)}`);
				}
			}, [inputActions, t, fail, finish, cancel, releaseCapture, transcribe]);

			const hidePage = React.useCallback(() => {
				if (document.visibilityState === "hidden" && runtime.current.recorder) cancel();
			}, [cancel]);
			React.useEffect(() => {
				document.addEventListener("visibilitychange", hidePage);
				return () => document.removeEventListener("visibilitychange", hidePage);
			}, [hidePage]);

			const busy = state === "starting" || state === "transcribing";
			if (state === "recording") {
				return h(React.Fragment, null,
					h(SlotStyles),
					h("button", {
						className: "lw-btn", type: "button", onClick: finish,
						"aria-label": t("stop"), title: t("stop")
					},
					h("span", { className: "lw-dot", "aria-hidden": true }),
					h("span", { className: "lw-time" }, fmtClock(elapsed)),
					h(StopIcon)),
					h("button", {
						className: "lw-btn", type: "button", onClick: cancel,
						"aria-label": t("cancel"), title: t("cancel")
					}, "✕"));
			}
			if (state === "transcribing") {
				return h(React.Fragment, null,
					h(SlotStyles),
					h("span", {
						className: "lw-btn", style: { cursor: "default" },
						"aria-label": t("transcribing"), title: t("transcribing")
					},
					h("span", { className: "lw-spin", "aria-hidden": true }),
					h("span", { className: "lw-time" }, t("transcribing"))));
			}
			if (state === "error") {
				return h(React.Fragment, null,
					h(SlotStyles),
					h("button", {
						className: "lw-btn", type: "button", onClick: start,
						"aria-label": `${t("failed")} — ${errorText}`, title: `${t("failed")} — ${errorText}`
					},
					h("span", { className: "lw-err", "aria-hidden": true }, "!"),
					h("span", { className: "lw-time lw-err" }, "다시 시도")),
					// Visible reason: mobile has no way to read title tooltips.
					h("span", { className: "lw-why lw-err", title: errorText }, errorText));
			}
			return h(React.Fragment, null,
				h(SlotStyles),
				h("button", {
					className: "lw-btn", type: "button", disabled: busy, onClick: start,
					"aria-label": t("record"), title: t("record")
				},
				h(MicIcon)));
		}

		return {
			inject: ["slots", "locale"],
			apply(ctx) {
				let t = (key) => DICT.ko[key] ?? key;
				try {
					ctx.locale.register(NS, DICT);
					const bound = ctx.locale.bind(NS);
					if (typeof bound === "function") t = bound;
				} catch (error) {
					console.warn("[local-wispr] locale service unavailable; using Korean literals", error);
				}

				ctx.slots.inject("conversation.input.right", () => ctx.slots.register(
					{
						name: "conversation.input.right",
						id: "local-wispr",
						order: 5,
						label: "Voice input (local Whisper)"
					},
					function LocalWisprEntry(props) {
						return h(VoiceButton, { inputActions: props?.inputActions, t });
					}
				));
			}
		};
	},
});
