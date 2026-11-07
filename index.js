/**
 * Local Wispr — host half.
 *
 * Serves two same-origin, trust-fenced routes on the Harness web server and
 * forwards them to the local Whisper gateway (pi-voice-board):
 *
 *   POST /local-wispr/transcribe  raw audio body → { text, seconds, elapsed }
 *   GET  /local-wispr/health      → gateway /health snapshot
 *
 * The browser never talks to 127.0.0.1:8813 directly (that server sends no
 * CORS headers and must stay loopback-only); this route is the only bridge.
 */
import z from "@deepseek-ai/schemastery";

export const inject = ["webServer", "connection"];

export const Config = z.object({
	/** Base URL of the local pi-voice-board Whisper gateway. */
	endpoint: z.string().min(1).default("http://127.0.0.1:8813"),
	/** Language hint forwarded as ?lang= ("auto" lets faster-whisper detect). */
	lang: z.string().min(1).default("ko"),
	/** Deadline for one transcription request, including server-side inference. */
	timeoutMs: z.natural().min(1000).default(240000),
	/** Maximum accepted recording body size. */
	maxBodyBytes: z.natural().min(1024).default(30 * 1024 * 1024)
}).description("Local Wispr configuration.");

/** @returns {Promise<Buffer>} the request body, or null when it exceeds limit. */
function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				resolve(null);
				req.removeAllListeners("data");
				req.removeAllListeners("end");
				req.resume();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/**
 * Register the transcription provider routes for the lifetime of this plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host registry context.
 * @param {{ endpoint: string, lang: string, timeoutMs: number, maxBodyBytes: number }} config - validated configuration.
 */
export function apply(ctx, config) {
	const base = config.endpoint.replace(/\/+$/, "");
	new URL(`${base}/`); // Fail fast on malformed endpoints.

	const webServer = ctx.get("webServer");
	const connection = ctx.get("connection");
	if (webServer === undefined) {
		console.error("[local-wispr] webServer service unavailable; routes not registered");
		return;
	}

	const rejectUntrusted = (req, res) => {
		const rejection = connection?.requestRejection?.(req);
		if (rejection === undefined) return false;
		res.statusCode = rejection;
		res.end();
		return true;
	};

	const sendJson = (res, status, payload) => {
		res.statusCode = status;
		res.setHeader("content-type", "application/json; charset=utf-8");
		res.setHeader("cache-control", "no-store");
		res.end(JSON.stringify(payload));
	};

	const upstream = async (path, init) => {
		const response = await fetch(`${base}${path}`, {
			...init,
			signal: AbortSignal.timeout(config.timeoutMs)
		});
		const payload = await response.json().catch(() => undefined);
		if (!response.ok || payload === undefined) {
			const detail = payload && payload.error ? `: ${payload.error}` : "";
			throw new Error(`Whisper gateway responded ${response.status}${detail}`);
		}
		return payload;
	};

	ctx.effect(() => {
		const disposers = [
			webServer.register({
				kind: "exact",
				path: "/local-wispr/transcribe",
				handler: async (req, res) => {
					if (rejectUntrusted(req, res)) return;
					if (req.method !== "POST") {
						sendJson(res, 405, { error: "POST audio bytes; anything else is not accepted" });
						return;
					}
					try {
						const body = await readBody(req, config.maxBodyBytes);
						if (body === null) {
							sendJson(res, 413, { error: `Recording exceeds ${config.maxBodyBytes} bytes` });
							return;
						}
						if (body.length === 0) {
							sendJson(res, 400, { error: "Empty recording" });
							return;
						}
						const contentType = req.headers["content-type"] || "audio/webm";
						const payload = await upstream(
							`/api/transcribe?lang=${encodeURIComponent(config.lang)}`,
							{ method: "POST", headers: { "content-type": contentType }, body }
						);
						sendJson(res, 200, {
							text: typeof payload.text === "string" ? payload.text : "",
							seconds: Number(payload.duration) || 0,
							elapsed: Number(payload.elapsed) || 0
						});
					} catch (error) {
						if (error?.name === "TimeoutError" || error?.code === "ABORT_ERR") {
							sendJson(res, 504, { error: `Whisper gateway timed out after ${config.timeoutMs} ms` });
							return;
						}
						if (error?.cause?.code === "ECONNREFUSED" || error?.code === "ECONNREFUSED") {
							sendJson(res, 502, {
								error: `Whisper gateway unreachable at ${base} — start it with: systemctl --user start pi-voice-board`
							});
							return;
						}
						sendJson(res, 502, { error: `Transcription failed: ${String(error?.message ?? error)}` });
					}
				}
			}),
			webServer.register({
				kind: "exact",
				path: "/local-wispr/health",
				handler: async (req, res) => {
					if (rejectUntrusted(req, res)) return;
					try {
						const payload = await upstream("/health", { method: "GET" });
						sendJson(res, 200, payload);
					} catch (error) {
						sendJson(res, 200, { ok: false, whisper: "unreachable", error: String(error?.message ?? error) });
					}
				}
			})
		];
		return () => {
			for (const dispose of disposers.splice(0)) {
				try {
					dispose();
				} catch {
					/* registry may have torn down first */
				}
			}
		};
	}, "local-wispr: web routes");
}
