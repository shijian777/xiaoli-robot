# 小理本机 Bridge

This Node.js service runs on Windows or Debian Linux and connects a 小理 device to TiDB Agent Stack. It accepts authenticated recording streams at `/device`, transcribes hardware-labelled A/B segments, requests a structured mediation, synthesizes Chinese speech locally, and returns 16 kHz mono PCM.

## Prerequisites

- Windows 10 or 11 with a working Chinese `System.Speech` voice. `Microsoft Huihui Desktop` is preferred when installed.
- Node.js 24.16.0 or a later Node 24 release (`node --version`).
- An Agent Stack user API key, project ID, and text mediator Agent ID.
- Xfyun Real-time ASR Standard credentials (`APPID` and `APIKey`) for production transcription.
- A random device shared token provisioned separately on the PC and device. Do not reuse an Agent Stack key as the device token.
- Legacy non-Xfyun mode only: an Agent Stack ASR Agent ID and, optionally, Python 3.11 for local Whisper fallback.
- On Debian Linux: `sudo apt-get install -y espeak-ng ffmpeg` for the local TTS fallback.

## Install and configure

Run these commands from this `bridge` directory:

```powershell
Copy-Item .env.example .env.local
npm ci
npm test
```

Edit `.env.local` locally and fill every required blank value. Keep `AGENT_STACK_BASE_URL` pointed at the intended Agent Stack deployment and set `MEDIATOR_AGENT_ID` to the existing text mediator Agent. Production mode requires both `XFYUN_RTASR_APP_ID` and `XFYUN_RTASR_API_KEY`; setting only one is rejected, and `ASR_AGENT_ID` is not required in this mode. `DEVICE_SHARED_TOKEN` must exactly match the token configured on the device. `TTS_PROVIDER` is optional: it defaults to `windows` on Windows and `espeak-ng` elsewhere. For clearer Mandarin, set it to `xfyun` and configure the complete `XFYUN_TTS_APP_ID`, `XFYUN_TTS_API_KEY`, and `XFYUN_TTS_API_SECRET` triplet. `XFYUN_TTS_VOICE` defaults to `x4_xiaoyan`; `XFYUN_TTS_SPEED`, `XFYUN_TTS_VOLUME`, and `XFYUN_TTS_PITCH` each accept an integer from 0 to 100 and default to 50. Set `MOBILE_ADMIN_TOKEN` to a separate random printable-ASCII value of at least 32 characters to enable the phone management API and page. Never reuse the device token or a cloud credential. Keep every credential only in the local/server environment file; `.env.local` and temporary audio are ignored by Git.

To inspect the configured project and its Agents without exposing credentials or changing platform resources, run:

```powershell
node --env-file=.env.local scripts/discover-agent-stack.mjs
```

The script performs only `GET /api/console/projects` (without a project header) followed by `GET /api/agents` (scoped to `AGENT_STACK_PROJECT_ID`). It prints only IDs, names, and statuses. It never creates, updates, or deletes projects, Agents, or Sessions.

Start the Bridge with:

```powershell
npm start
```

The default listener is `0.0.0.0:8788`. The device WebSocket endpoint is `/device`; `GET /healthz` returns `{"status":"ok"}` without contacting external APIs.

When `MOBILE_ADMIN_TOKEN` is set, `/mobile/` serves the responsive management page and `/api/mobile/v1/` exposes its bearer-protected API. It can view sanitized device/case state and accumulated A/B transcripts, submit the same durable mediation request used by the hardware protocol, and update Xfyun voice, speed, volume, and pitch for subsequent playback. Hardware buttons remain the only recording controls. `/downloads/xiaoli-control.apk` serves the generated Android package when it is present in `public/downloads/`; neither the page nor APK embeds the admin token or any cloud/device credential.

## Windows Firewall and discovery

On a trusted private LAN, run this once in an Administrator PowerShell window to allow inbound device connections:

```powershell
New-NetFirewallRule -DisplayName "小理本机 Bridge 8788" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8788 -Profile Private
```

The Bridge advertises `小理本机 Bridge` as `_xiaoli._tcp.local` with TXT `protocol=1`. Firmware may discover that service through mDNS. Multicast discovery is sometimes blocked by guest Wi-Fi, AP isolation, VPN software, or firewall policy; in that case configure the device manually with:

```text
ws://<Windows-PC-LAN-IP>:8788/device
```

Use the PC's LAN address, not `127.0.0.1` or `localhost`, because those names refer to the device itself from the device's point of view. Keep the PC and device on the same trusted LAN.

## Production Xfyun ASR and legacy fallback mode

When both Xfyun variables are configured, Xfyun Real-time ASR Standard is the sole ASR path and receives the device's native 16 kHz, 16-bit mono PCM. A single hardware-labelled recording may contain up to ten minutes of PCM. An Xfyun error or empty result is surfaced explicitly; the Bridge does not send that recording to Agent Stack audio ASR or Whisper.

When both Xfyun variables are blank, the legacy mode requires `ASR_AGENT_ID`. Agent Stack audio ASR is used first; only an explicit audio-unavailable response can invoke the pinned `faster-whisper` fallback locally:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements-whisper.txt
```

## Xfyun speech synthesis

With `TTS_PROVIDER=xfyun`, the Bridge sends only the final mediation playback text to Xfyun's online TTS service and requests raw 16 kHz, 16-bit, mono PCM for the device. Voice, speed, volume, and pitch are configurable through the environment values above; an in-flight synthesis keeps the settings it started with. The primary call is retried once. If both cloud calls fail, the Bridge falls back to the platform-local synthesizer (`windows` on Windows or `espeak-ng` on Linux) without invoking the mediation Agent again. Cancellation never triggers a retry or fallback.

The firmware protocol and audio format are unchanged, so switching TTS providers is a server-only configuration change and does not require reflashing the ESP32.

Set `PYTHON_BIN` in `.env.local` to the absolute path of `.venv\Scripts\python.exe`. The fallback always uses the `small` model with CPU `int8`; its first use may need network access to obtain the model. Preload it before an offline demonstration.

## Fake-device check

With the Bridge running, this command sends deterministic A and B PCM snippets, waits for both transcripts and mediation playback, and writes the returned audio to `tmp/fake-device-result.wav`:

```powershell
npm run fake-device
```

The fake device reads `DEVICE_SHARED_TOKEN` from `.env.local` and never prints it. A successful exit occurs only after `audio.end` and the WAV has been saved.

## Hardware-only local check

Before real Agent Stack credentials are ready, the firmware can exercise the complete Wi-Fi path against a deterministic local service. Put only a local `DEVICE_SHARED_TOKEN` in the ignored `.env.local` file, use the same token in the device provisioning portal, then run:

```powershell
npm run hardware-mock
```

This mode binds the normal Bridge endpoint, advertises `xiaoli-bridge.local`, validates that each uploaded WAV contains non-silent PCM, returns deterministic A/B transcripts and mediation data, and sends a three-second rising tone to the device speaker. It does not contact Agent Stack and never prints the token. Replace this mode with `npm start` for the real cloud acceptance run.

## Privacy and local data lifetime

- Secrets are read only from `.env.local` or the process environment. They are not embedded in source code or ordinary logs.
- Ordinary logs contain identifiers, states, timings, and sanitized error names; they do not contain full A/B statements, authorization headers, or the device token.
- Each uploaded PCM segment is atomically staged as a Bridge-owned WAV. The durable ACK is sent only after that file exists. WAVs for terminal jobs are removed, while an in-flight durable WAV may remain in `BRIDGE_TEMP_DIR` so transcription can resume after restart.
- Transcripts, case metadata, ACKs, and pending jobs are persisted in `BRIDGE_STATE_DIR` for restart recovery. They remain until the device replaces the case or an operator deliberately removes the protected state directory; the Debian service stores them under `/var/lib/xiaoli-bridge/state` with service-only access. Agent Stack retains Sessions according to its own configured policy.
- The generated fake-device result is a deliberate local output and is not uploaded by the fake-device script.

## Sanitized troubleshooting

Do not paste `.env.local`, request headers, recordings, transcripts, or raw Agent Stack responses into logs or issue reports.

- **Bridge does not start:** confirm `node --version` is Node 24, all required `.env.local` fields are non-empty, and the base URL is valid. Report only the sanitized error name.
- **Port is unavailable:** inspect the listener with `Get-NetTCPConnection -LocalPort 8788 -State Listen`. Stop the conflicting local process or choose another `BRIDGE_PORT`, then update the device endpoint and firewall rule consistently.
- **Device cannot connect:** verify both hosts are on the same private LAN, TCP 8788 is allowed, the endpoint ends in `/device`, and the device clock/network are stable. Authentication failure closes with code `4003`; compare the two token configurations locally without printing either value.
- **mDNS is not found:** temporarily disable VPN routing, check AP/client isolation, and try the manual LAN-IP endpoint. mDNS failure does not prevent direct-IP operation.
- **Transcription fails:** in production Xfyun mode, verify that both RTASR variables belong to the same application and that the Real-time ASR Standard entitlement is active; Xfyun failures do not fall through to another recognizer. In legacy non-Xfyun mode, verify the ASR Agent ID and project membership. For local fallback, run the configured Python executable with `--version` and confirm `requirements-whisper.txt` was installed; do not include transcript content in diagnostics.
- **TTS fails:** for Xfyun, verify that all three TTS credentials belong to the same application, the online TTS entitlement is active, and `XFYUN_TTS_VOICE` names an enabled voice. On Windows, confirm an enabled Chinese speech voice; on Debian, confirm both `espeak-ng` and `ffmpeg` are installed and available on `PATH` for fallback. Run `npm test` locally. Text mediation remains in memory even when playback cannot be synthesized.
- **Sequence or size errors:** the device must start each PCM stream at sequence 0, increment one per chunk, send even-length 16-bit PCM, and provide canonical `speech.end` fields `bytes`, `lastSequence`, and `complete`.
