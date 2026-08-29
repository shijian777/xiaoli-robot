# Debian 12 deployment

These assets install the Bridge as an unprivileged, loopback-only systemd service. Caddy is the only public ingress and proxies HTTPS/WSS to `127.0.0.1:8788`. They are for Debian 12 and use Node.js 24.20.0.

## Prerequisites

- A clean checkout containing `bridge/package.json` and `bridge/package-lock.json`.
- A DNS name you control, such as `bridge.example.com`, pointing to the host before enabling Caddy. Do not use a previous domain merely because it used to point at another server.
- Public inbound TCP ports 80 and 443 (for Caddy's TLS certificate issuance and HTTPS/WSS).
- Root access. The installer downloads Node.js and installs Debian packages, but never contains credentials.

## Install

From the repository checkout, run:

```bash
sudo ./deploy/debian/install.sh
```

The installer is safe to re-run where practical: it reuses an existing `/opt/node/bin/node` when it is Node 24, creates the service account and directories if absent, preserves an existing `/etc/xiaoli-bridge/bridge.env`, and stages a locked dependency install in `/opt/xiaoli-bridge.next` before syntax-checking and switching it into place. The previous release is retained as `/opt/xiaoli-bridge.previous` for rollback. It does not start a previously stopped Bridge, because the required secrets are deliberately absent.

It writes the versioned Bridge runtime to `/opt/xiaoli-bridge`, creates the separate service-owned directories `/var/lib/xiaoli-bridge/tmp` for ephemeral audio and `/var/lib/xiaoli-bridge/state` for durable cases/jobs, and installs `/etc/xiaoli-bridge/bridge.env` with mode `0600` and owner `root:root`. Both data directories remain outside release swaps and rollbacks. The unit forces `BRIDGE_TEMP_DIR`, Node's `TMPDIR`, and `BRIDGE_STATE_DIR` inside the read-only filesystem sandbox even if an older preserved environment file has stale or missing path values.

## Configure and start

Edit the root-only environment file and set the required values without placing them in the checkout:

```bash
sudoedit /etc/xiaoli-bridge/bridge.env
```

The common required entries are `AGENT_STACK_BASE_URL`, `AGENT_STACK_USER_API_KEY`, `AGENT_STACK_PROJECT_ID`, `MEDIATOR_AGENT_ID`, and `DEVICE_SHARED_TOKEN`. Production Xfyun ASR additionally requires `XFYUN_RTASR_APP_ID` and `XFYUN_RTASR_API_KEY`; `ASR_AGENT_ID` is optional in that mode and required only when both RTASR values are blank. For clear Mandarin playback, set `TTS_PROVIDER=xfyun` and provide `XFYUN_TTS_APP_ID`, `XFYUN_TTS_API_KEY`, and `XFYUN_TTS_API_SECRET` together. `XFYUN_TTS_VOICE` is optional and defaults to `x4_xiaoyan`. The Bridge retries Xfyun TTS once and then uses local `espeak-ng` as a playback fallback. To enable the phone management page, set `MOBILE_ADMIN_TOKEN` to a new independent random printable-ASCII value of at least 32 characters; do not reuse the device token or any cloud API key. Keep `BRIDGE_PORT=8788`, `BRIDGE_TEMP_DIR=/var/lib/xiaoli-bridge/tmp`, and `BRIDGE_STATE_DIR=/var/lib/xiaoli-bridge/state`. The service itself forces `BRIDGE_HOST=127.0.0.1`, `BRIDGE_MDNS_ENABLED=false`, `BRIDGE_TEMP_DIR=/var/lib/xiaoli-bridge/tmp`, `BRIDGE_STATE_DIR=/var/lib/xiaoli-bridge/state`, and `TMPDIR=/var/lib/xiaoli-bridge/tmp` so a preserved environment file cannot widen the public listener, re-enable mDNS, overlap temp/state, or move either path outside the sandbox.

After HTTPS is working, open `https://<your-domain>/mobile/` and enter only the `MOBILE_ADMIN_TOKEN`. The page shows sanitized online/case state and accumulated A/B transcripts, can submit a durable mediation request, and can change Xfyun voice controls. The Android package, when included in the reviewed release, is available at `https://<your-domain>/downloads/xiaoli-control.apk`. The page and APK never contain Agent Stack, Xfyun, or device credentials.

The installer deliberately does not overwrite an existing Caddy configuration unless you opt in. After your DNS name points at the host, install the reviewed example once (the old Caddyfile is saved as `/etc/caddy/Caddyfile.before-xiaoli`), replace every occurrence of `bridge.example.com` with that DNS name, then verify and enable the public ingress:

```bash
sudo INSTALL_CADDY_CONFIG=1 ./deploy/debian/install.sh
sudoedit /etc/caddy/Caddyfile
sudo systemctl start xiaoli-bridge.service
curl --fail http://127.0.0.1:8788/healthz
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable caddy
sudo systemctl reload-or-restart caddy
```

## Verify

Run these checks after configuration:

```bash
sudo systemctl status xiaoli-bridge.service --no-pager
sudo systemctl status caddy --no-pager
sudo ss -ltnp '( sport = :8788 )'
curl --fail http://127.0.0.1:8788/healthz
curl --fail --resolve bridge.example.com:443:127.0.0.1 https://bridge.example.com/healthz
```

The `ss` output must show `127.0.0.1:8788` (or `[::1]:8788` only if you intentionally change the bind address), never a public interface. Caddy's `reverse_proxy` supports WebSocket upgrades automatically; devices use `wss://<your-domain>/device`.

From a network that reaches the public hostname, connect a device configured with its real shared token and verify that the first protocol response is `hello.ack`. Repeat with an intentionally wrong token and verify the WebSocket closes with code `4003` (`authentication failed`); never place either token in shell history, command output, or this repository. Also verify the non-WebSocket error path with `curl --fail --resolve bridge.example.com:443:127.0.0.1 https://bridge.example.com/healthz` and confirm a request to an unrelated HTTPS path is rejected rather than proxied as a device session.

## Update and rollback

To update, pull or otherwise obtain the intended reviewed checkout and re-run the installer. It reinstalls dependencies using the committed lockfile.

To roll back the most recent staged switch, stop the Bridge, restore both retained release files, reload systemd, then start and health-check it:

```bash
sudo systemctl stop xiaoli-bridge.service
sudo rm -rf /opt/xiaoli-bridge
sudo mv /opt/xiaoli-bridge.previous /opt/xiaoli-bridge
sudo mv /etc/systemd/system/xiaoli-bridge.service.previous /etc/systemd/system/xiaoli-bridge.service
sudo systemctl daemon-reload
sudo systemctl start xiaoli-bridge.service
for attempt in {1..7}; do
  curl --fail --silent --show-error --output /dev/null --max-time 1 http://127.0.0.1:8788/healthz && break
  [ "$attempt" -lt 7 ] && sleep 1
done
curl --fail --silent --show-error --output /dev/null --max-time 1 http://127.0.0.1:8788/healthz
```

For an older reviewed release, restore that checkout and re-run the installer instead. The root-owned `/etc/xiaoli-bridge/bridge.env` and service-owned `/var/lib/xiaoli-bridge/state` are outside both release directories and remain untouched.

If a Caddy configuration change is involved, first restore the previous `/etc/caddy/Caddyfile`, validate it, and reload Caddy:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload-or-restart caddy
```

Do not delete `/etc/xiaoli-bridge/bridge.env` during rollback unless the credentials are intentionally being rotated.
