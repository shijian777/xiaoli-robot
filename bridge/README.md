# 小理本机 Bridge

This Node.js service runs on a Windows PC and connects a 小理 device to TiDB Agent Stack. It accepts authenticated recording streams at `/device`, transcribes hardware-labelled A/B segments, requests a structured mediation, synthesizes Chinese speech locally, and returns 16 kHz mono PCM.

## Prerequisites

- Windows 10 or 11 with a working Chinese `System.Speech` voice. `Microsoft Huihui Desktop` is preferred when installed.
- Node.js 24.16.0 or a later Node 24 release (`node --version`).
- A rotated Agent Stack user API key, project ID, ASR Agent ID, and mediator Agent ID.
- A random device shared token provisioned separately on the PC and device. Do not reuse an Agent Stack key as the device token.
- Optional: Python 3.11 for the local Whisper fallback.

## Install and configure

Run these commands from this `bridge` directory:

```powershell
Copy-Item .env.example .env.local
npm ci
npm test
```

Edit `.env.local` locally and fill every blank value. Keep `AGENT_STACK_BASE_URL` pointed at the intended Agent Stack deployment, and set the two Agent IDs to agents with the ASR and mediation responsibilities described by this project. `DEVICE_SHARED_TOKEN` must exactly match the token configured on the device. `.env.local` and temporary audio are ignored by Git.

Start the Bridge with:

```powershell
npm start
```

The default listener is `0.0.0.0:8788`. The device WebSocket endpoint is `/device`.

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

## Optional Whisper fallback

Agent Stack ASR is used first. If that endpoint explicitly reports that audio transcription is unavailable, the Bridge can run the pinned `faster-whisper` fallback locally:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements-whisper.txt
```

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
- Each uploaded PCM segment is atomically staged as a Bridge-owned WAV. The durable ACK is sent only after that file exists, and ASR removes it in `finally` after success or final failure. Shutdown removes any remaining Bridge-owned staging files.
- Transcripts and case state stay in process memory for the current run. Agent Stack retains Sessions according to its own configured policy.
- The generated fake-device result is a deliberate local output and is not uploaded by the fake-device script.

## Sanitized troubleshooting

Do not paste `.env.local`, request headers, recordings, transcripts, or raw Agent Stack responses into logs or issue reports.

- **Bridge does not start:** confirm `node --version` is Node 24, all required `.env.local` fields are non-empty, and the base URL is valid. Report only the sanitized error name.
- **Port is unavailable:** inspect the listener with `Get-NetTCPConnection -LocalPort 8788 -State Listen`. Stop the conflicting local process or choose another `BRIDGE_PORT`, then update the device endpoint and firewall rule consistently.
- **Device cannot connect:** verify both hosts are on the same private LAN, TCP 8788 is allowed, the endpoint ends in `/device`, and the device clock/network are stable. Authentication failure closes with code `4003`; compare the two token configurations locally without printing either value.
- **mDNS is not found:** temporarily disable VPN routing, check AP/client isolation, and try the manual LAN-IP endpoint. mDNS failure does not prevent direct-IP operation.
- **Transcription fails:** verify the ASR Agent ID and project membership in the Agent Stack console. For fallback, run the configured Python executable with `--version` and confirm `requirements-whisper.txt` was installed; do not include transcript content in diagnostics.
- **TTS fails:** confirm Windows has an enabled Chinese speech voice and run `npm test` locally. Text mediation remains in memory even when playback cannot be synthesized.
- **Sequence or size errors:** the device must start each PCM stream at sequence 0, increment one per chunk, send even-length 16-bit PCM, and provide canonical `speech.end` fields `bytes`, `lastSequence`, and `complete`.
