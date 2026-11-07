# The gateway used by Local Wispr

Local Wispr talks to any tiny HTTP server that exposes:

```
POST /api/transcribe?lang=<hint>   raw audio body (webm/ogg/mp4/wav) → {"text": "...", "duration": 3.7, "elapsed": 4.1}
GET  /health                       → {"whisper": "ready", "model": "large-v3-turbo", ...}
```

`duration` is the audio length in seconds and `elapsed` the inference time; both are
optional (the plugin degrades gracefully when missing).

## pi-voice-board (the author's gateway)

`pi-voice-board` is a ~240-line Python stdlib server that lazily loads
**faster-whisper large-v3-turbo (int8, CPU)** via the `ml-study` venv, converts incoming
audio with ffmpeg (16 kHz mono), and serves the two endpoints above on `127.0.0.1:8813`.
It is bound to loopback only — the plugin's host half proxies same-origin requests to it,
so nothing else needs to reach it.

Any equivalent faster-whisper/whisper.cpp server works. If you expose yours over the
network instead of loopback, put it behind the same-origin route of the plugin (or another
authenticated proxy) rather than letting browsers hit it directly.
