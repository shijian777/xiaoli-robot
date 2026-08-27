# 小理端到端 Integration and Delivery Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已测试的本机 Bridge、TiDB Agent Stack 两个 Agent 和 D 板固件连接起来，在 COM3 实机上连续完成可重复的 A/B 语音调解，并形成比赛可复现材料。

**Architecture:** 先轮换已经暴露的账号/UAK，再分别验证 Agent Stack 文本 Turn、音频 Turn和本机 TTS；随后连接真实 D 板，通过同一 Wi-Fi 完成录音、A/B 转写、结构化调解和 PCM 播放。最后执行断线/失败降级、密钥扫描和三次连续 Demo 验收。

**Tech Stack:** Agent Stack Console 与 HTTP API、Node Bridge、Windows PowerShell、可选 Python 3.11/faster-whisper、ESP-IDF 5.4.4、COM3、Git/Markdown/Mermaid。

**Spec:** `docs/plans/2026-08-28-xiaoli-wifi-mediation-design.md`

## Global Constraints

- 不使用聊天中已经暴露的旧密码和旧 UAK；第一项工作必须完成轮换。
- 轮换密码/UAK、创建或修改 Agent、创建 Session/Turn 都是外部状态变更；执行时必须在动作发生前获得用户明确确认。
- 新密码和新 UAK 不得出现在聊天、命令文本、终端输出、Git、截图、PPT、Demo 视频或普通日志中。
- D 板和 Windows 电脑必须处于同一个可互访的 2.4 GHz 局域网。
- 实机身份固定：左键 GPIO40=A，右键 GPIO39=B，独立键 GPIO0=案件/调解。
- 只有真实录音、真实 Agent 判断和真实扬声器输出构成验收成功。
- 当前黑屏可以作为已知限制，但不能用预录音频替代真实 Agent/TTS 链路。

---

## File Structure

```text
bridge/
├── .env.local                            local secret file, ignored
├── scripts/
│   ├── discover.mjs                      read-only project/agent discovery
│   └── cloud-smoke.mjs                   explicit-write ASR/mediation smoke
└── tmp/                                  ignored transient smoke audio

docs/
├── architecture-xiaoli-mediation.md      one-page Mermaid architecture
├── demo-xiaoli-mediation.zh-CN.md        three-minute demo script/checklist
└── agent-stack-xiaoli.zh-CN.md           Agent/Skill/Turn/Trace explanation

README.zh-CN.md                           full shortest reproduction path
```

### Task 1: Rotate compromised credentials and prepare local secrets

**Files:**
- Create locally, never commit: `bridge/.env.local`
- Verify: `bridge/.gitignore`

**Interfaces:**
- Produces: fresh Console password and fresh UAK held by the user/local environment
- Produces: Bridge variables `AGENT_STACK_BASE_URL`, `AGENT_STACK_USER_API_KEY`, `AGENT_STACK_PROJECT_ID`, `ASR_AGENT_ID`, `MEDIATOR_AGENT_ID`, `DEVICE_SHARED_TOKEN`

- [ ] **Step 1: Confirm rotation immediately before changing external credentials**

State exactly that the current Console password and UAK appeared in chat, that rotation invalidates the old values, and that the new values must not be pasted back into chat. Wait for explicit approval before submitting either rotation.

- [ ] **Step 2: Rotate the Console password**

Use the Agent Stack Console self-service password screen. Generate a unique password, let the user store it in their password manager, submit once, then verify a new login succeeds. Do not save it in the browser or project.

- [ ] **Step 3: Rotate or revoke/recreate the UAK**

Use the Console self-service API-key screen. Record only display-safe metadata such as key name/prefix in verification notes; the full token is stored once by the user in `bridge/.env.local`. Confirm the old UAK no longer authenticates using a sanitized 401 result.

- [ ] **Step 4: Create a device token independently from the UAK**

Generate at least 32 random bytes encoded as Base64URL. Store the same value in `bridge/.env.local` and the device's ignored menuconfig/NVS entry. Never reuse the Agent Stack UAK as the device token.

- [ ] **Step 5: Verify local ignore rules before entering secrets**

Run: `git check-ignore -v bridge/.env.local`
Expected: matches `bridge/.gitignore`. If it does not, stop before creating the file.

- [ ] **Step 6: Have the user enter local values without echo**

Copy `bridge/.env.example` to `bridge/.env.local`, then have the user fill the password-type/secret fields directly in VS Code or another local editor. Do not read or print the completed file. Leave Project and Agent IDs empty until discovery/configuration completes.

### Task 2: Discover Project and configure two Agents

**Files:**
- Create: `bridge/scripts/discover.mjs`
- Modify: `bridge/package.json`
- Update locally, never commit: `bridge/.env.local`

**Interfaces:**
- Produces: one selected Project ID, one ASR Agent ID and one mediator Agent ID

- [ ] **Step 1: Implement a read-only discovery script**

Use `AgentStackClient.listProjects()` and `.listAgents()`. Print only project IDs/names and Agent IDs/names; never print request headers or the UAK. Exit non-zero when no project is available.

- [ ] **Step 2: Test discovery formatting with a fake client**

Add a Node test that supplies two fake projects and agents, captures stdout, and asserts IDs/names are present while `test-uak-not-real` is absent.

- [ ] **Step 3: Run real read-only discovery**

Run: `cd bridge; npm run discover`
Expected: at least one accessible Project and Agent list. Have the user enter the selected Project ID into `.env.local` without showing the file.

- [ ] **Step 4: Confirm immediately before creating/configuring Agents**

Explain that this creates two persistent Agent resources in the user's Agent Stack project. Wait for approval before submitting writes.

- [ ] **Step 5: Configure the transcription Agent**

Name: `小理-忠实转写`.

System behavior:

```text
你是忠实语音转写器。只转写用户音频中的原始内容，不总结、不评价、不判断说话者身份、不补充未说出的信息。听不清的内容写为“[听不清]”。只返回一个 JSON 对象，字段严格为 transcript:string 与 unclear:boolean，不要 Markdown，不要其他文字。
```

Select an available model/AgentDefinition that supports the deployed audio Turn. Record its Agent ID locally as `ASR_AGENT_ID`.

- [ ] **Step 6: Configure the mediation Agent**

Name: `小理天秤官`.

System behavior must include: neutral mediation; identify each side's position/emotion/needs; distinguish allegations from verified facts; explain misunderstandings; give concrete communication steps; do not declare a winner; do not mechanically split blame; stop ordinary mediation and prioritize safety for violence, self-harm, abuse or immediate danger; return only the approved eight-field JSON; keep `spokenText` to about one minute.

Record its Agent ID locally as `MEDIATOR_AGENT_ID`.

- [ ] **Step 7: Commit only the discovery code**

```bash
git add bridge/scripts/discover.mjs bridge/package.json bridge/package-lock.json bridge/test
git commit -m "feat(bridge): add safe Agent Stack discovery"
```

### Task 3: Cloud ASR, mediation and TTS smoke

**Files:**
- Create: `bridge/scripts/cloud-smoke.mjs`
- Modify: `bridge/package.json`
- Test: `bridge/test/services.test.mjs`

**Interfaces:**
- Produces: sanitized smoke result with `asr=agent-stack|whisper`, mediation schema PASS and 16 kHz TTS PASS

- [ ] **Step 1: Implement the smoke script without printing content**

The script synthesizes `A方测试陈述：我希望对方准时沟通。` locally, calls the ASR service, reports only transcript character count and provider, creates a mediator Session, sends synthetic A/B JSON, validates all fields, synthesizes `spokenText`, and reports PCM byte count/duration. It must not print the transcript or spoken text.

- [ ] **Step 2: Add an explicit external-write guard**

Require command-line flag `--confirm-create-turns`; without it, print that the smoke would create Agent Stack Sessions/Turns and exit 2. This prevents accidental repeated writes.

- [ ] **Step 3: Run unit tests first**

Run: `cd bridge; npm test`
Expected: all tests PASS with mock HTTP; no external traffic.

- [ ] **Step 4: Confirm immediately before real Sessions/Turns**

Explain that the smoke creates remote Session/Turn history and consumes contest model/ASR allowance. Wait for approval.

- [ ] **Step 5: Run the cloud smoke**

Run: `cd bridge; npm run cloud-smoke -- --confirm-create-turns`
Expected: project/agent access succeeds, ASR returns a non-empty transcript or explicit 501 fallback, mediation JSON validates, TTS is 16000/16/1.

- [ ] **Step 6: Install Whisper only if the real audio endpoint returns 501**

Before installing Python, obtain the user's software-install approval. Then install Python 3.11, create `bridge/.venv`, install `bridge/requirements-whisper.txt`, and let `faster-whisper` download the `small` model once. Rerun cloud smoke and expect `asr=whisper` with non-empty transcript.

- [ ] **Step 7: Commit the guarded smoke script**

```bash
git add bridge/scripts/cloud-smoke.mjs bridge/package.json bridge/package-lock.json bridge/test/services.test.mjs
git commit -m "test(bridge): add guarded cloud smoke"
```

### Task 4: Real D-board vertical slice

**Files:**
- No source change unless the vertical slice reveals a verified defect
- Capture sanitized logs under ignored `bridge/tmp/`

**Interfaces:**
- Consumes: production Bridge, configured Agents and production firmware
- Produces: one real A/B mediation played by the D-board speaker

- [ ] **Step 1: Start Bridge and verify listening state**

Run: `cd bridge; npm start`
Expected: sanitized log shows port 8788 and mDNS service, with no UAK/token values.

- [ ] **Step 2: Allow the exact Windows Firewall rule if needed**

At the firewall prompt, allow Node only on Private networks. If a manual firewall rule is needed, obtain confirmation immediately before changing the setting and scope it to TCP 8788, Private profile and the Node executable only.

- [ ] **Step 3: Flash production firmware to COM3**

Run: `idf.py -B build-rorolee -p COM3 flash monitor`
Expected: normal ROROLEE-Basic firmware boots; this replaces any Unity test app.

- [ ] **Step 4: Provision Wi-Fi and Bridge settings**

Join the device SoftAP, enter the 2.4 GHz SSID/password, endpoint `ws://xiaoli-bridge.local:8788/device` and the device token. If mDNS fails, run `Get-NetIPConfiguration`, copy the active private IPv4 value into a local variable named `$bridgeIp`, and enter the URI formed as `"ws://${bridgeIp}:8788/device"` in the portal without changing code.

- [ ] **Step 5: Verify deterministic button mapping**

Short press GPIO0 to create a case. Press physical left GPIO40, speak one A statement, press again. Press physical right GPIO39, speak one B statement, press again. Bridge logs must show one saved A segment and one saved B segment without printing content.

- [ ] **Step 6: Request and play mediation**

Hold GPIO0 for at least three seconds. Expected ordered states: pending transcripts -> mediating -> TTS -> playing -> waiting. Speaker output must be dynamic Chinese speech and the PCM downlink must finish with `audio.end`.

- [ ] **Step 7: Verify supplements reuse the case**

Add one more A segment and one more B segment, long-press again, and confirm the same case Session produces a revised result while segment IDs remain unique.

### Task 5: Failure and recovery tests

**Files:**
- Modify verified defects only in the owning Bridge/firmware files
- Add regression tests beside each verified defect before the fix

**Interfaces:**
- Produces: evidence for bounded recovery behavior

- [ ] **Step 1: Bridge disconnect during idle**

Stop Bridge, observe device DISCONNECTED/error feedback, restart Bridge, and expect READY without reboot or duplicate case creation.

- [ ] **Step 2: Bridge disconnect during recording**

Start an A recording, stop Bridge, and confirm the segment closes incomplete. After reconnect, it must not appear as a saved transcript; a fresh A recording must work.

- [ ] **Step 3: Opposite-key exclusion**

While A records, press physical right. Expect a 120 ms error vibration, continued A state and no B segment. Repeat symmetrically for B.

- [ ] **Step 4: Empty-side mediation guard**

Create a case with only A, long-press GPIO0, and expect `missing_party_statement`; no Agent mediation Turn or TTS is created.

- [ ] **Step 5: Invalid Agent result guard**

Use a mock mediator returning invalid JSON. Expect no TTS, recoverable error state and current case retained.

- [ ] **Step 6: Run regression suites after every fix**

Run:

```powershell
cd bridge
npm test
cd ..
idf.py -C test_apps/xiaoli_state build
idf.py -B build-rorolee build
```

Expected: Bridge tests PASS and both ESP-IDF builds succeed.

### Task 6: Three-run acceptance and secret audit

**Files:**
- No new source files

**Interfaces:**
- Produces: final acceptance checklist with three successful case IDs and sanitized durations

- [ ] **Step 1: Perform three consecutive fresh cases**

Each run must contain real A speech, real B speech, Agent mediation and complete speaker playback. Record only case ID, ASR duration, Agent duration, TTS duration and PASS/FAIL.

- [ ] **Step 2: Run tracked-secret scan**

Run:

```powershell
git grep -n -E "ag9_(uak|wak)_[A-Za-z0-9_-]{12,}|Authorization:[[:space:]]*Bearer[[:space:]]+[A-Za-z0-9_-]{12,}" -- .
git status --short
git diff --check
```

Expected: secret scan has no matches; `.env.local`, temp audio and logs are not tracked; no whitespace errors.

- [ ] **Step 3: Verify firmware binary does not contain Agent Stack credentials**

Search the built ELF strings for `ag9_uak`, the participant email and Agent Stack login password marker. Expected: no matches. The device token may exist in ignored `sdkconfig`/binary but must not appear in source or logs.

- [ ] **Step 4: Restore normal production firmware after any diagnostic image**

Flash `build-rorolee` to COM3, reboot, and verify Wi-Fi/Bridge READY. Do not leave the Unity test app or a hardware probe on the board.

### Task 7: Competition documentation and final commit

**Files:**
- Create: `docs/architecture-xiaoli-mediation.md`
- Create: `docs/demo-xiaoli-mediation.zh-CN.md`
- Create: `docs/agent-stack-xiaoli.zh-CN.md`
- Modify: `README.zh-CN.md`

**Interfaces:**
- Produces: one-page architecture source, three-minute Demo runbook and Agent Stack disclosure

- [ ] **Step 1: Create the one-page architecture source**

Use Mermaid and visibly distinguish: organizer-provided Agent Link/D board/Agent Stack; team-built state machine/Bridge/prompts; real inputs/outputs. Show A/B buttons, PCM/WAV, ASR Agent, mediator Agent, TTS and speaker.

- [ ] **Step 2: Write the three-minute Demo script**

Use timing: 0–30 seconds problem/user; 30–120 seconds one continuous case; 120–150 seconds architecture; 150–180 seconds innovation, privacy and known black-screen limitation. Include a preflight checklist for Wi-Fi, Bridge, COM3, volume and backup sanitized logs.

- [ ] **Step 3: Document Agent Stack usage**

Explain Project, two Agents, per-case Session, audio/text Turns, NDJSON, validation, TTS boundary and ASR 501 fallback. Include redacted event examples containing only fake IDs.

- [ ] **Step 4: Complete README reproduction path**

README must list exact D-board pins, ESP-IDF 5.4.4, Node 24, `npm ci`, `.env.example`, Agent setup, Bridge start, captive portal, build/flash COM3, shortest A/B interaction, failure recovery, privacy and current limitations.

- [ ] **Step 5: Review all competition requirements**

Confirm project/team section, Demo video checklist, one-page architecture, code/run instructions and Agent Stack explanation are all represented. Do not fabricate a completed video or team member information.

- [ ] **Step 6: Run final tests and commit**

Run: `cd bridge; npm test; cd ..; idf.py -B build-rorolee build; git diff --check`
Expected: all tests/builds PASS.

```bash
git add README.zh-CN.md docs/architecture-xiaoli-mediation.md docs/demo-xiaoli-mediation.zh-CN.md docs/agent-stack-xiaoli.zh-CN.md
git commit -m "docs: add Xiaoli competition delivery package"
```
