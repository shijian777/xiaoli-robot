# 小理 D 板 Wi-Fi Firmware Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 `rorolee-basic` 固件中补齐 Agent Link Wi-Fi WebSocket 数据面，并实现 GPIO0/40/39 驱动的 A/B 多轮调解状态机、音频上传、状态反馈和 TTS 播放。

**Architecture:** 现有 Wi-Fi STA 与 captive portal 保留；`transport_wifi.cpp` 在获得 IP 后建立 WebSocket，并把 Agent Link control/stream 调用映射到获批的 JSON + XL 二进制协议。板级业务使用 `agent_link_asr_*` 上传带 A/B JSON 元数据的录音，使用 custom event/command 传输案件状态，继续复用 Agent Link 的 TTS 下行与 ES8311 播放回调。

**Tech Stack:** ESP-IDF 5.4.4、ESP32-S3、C++17、FreeRTOS、`espressif/esp_websocket_client ^1.3.0`、cJSON、现有 ES7210/ES8311 驱动、Unity 设备测试。

**Spec:** `docs/plans/2026-08-28-xiaoli-wifi-mediation-design.md`

## Global Constraints

- 板型必须保持 `CONFIG_BOARD_TYPE_ESP32S3_ROROLEE_BASIC=y`；不得切换到 `rorolee-s3`。
- 串口固定使用实机 `COM3`，芯片为 ESP32-S3。
- A 固定为实物左键 GPIO40；B 固定为实物右键 GPIO39；GPIO0 为案件短按/3 秒长按。
- 音频固定 16000 Hz、16-bit little-endian、单声道、20 ms/640 byte PCM 帧。
- PA 使用 GPIO3；震动马达使用 GPIO1；不得改回此前错误引脚。
- 固件不得包含 Agent Stack UAK、登录账号或密码。
- WebSocket 发送不能阻塞 I2S 采集任务；音频队列满时必须标记片段不完整，不能静默丢帧。
- A/B 不能同时录音，录音期间另一方按键只能触发错误震动。
- 所有按键采用约 40 ms 消抖；GPIO0 长按 3 秒只触发一次。
- 当前 SH8501 黑屏不是核心闭环阻塞项；状态必须同时写入串口并提供震动/声音反馈。
- 保留工作区已有、尚未提交的硬件校准注释与 README 修改，不得覆盖或还原用户改动。

---

## File Structure

```text
components/agent_link/
├── idf_component.yml                    add esp_websocket_client dependency
├── CMakeLists.txt                       compile wifi_wire.cpp
├── include/
│   └── agent_link_transport.h           document Wi-Fi business command path
├── portal/
│   └── portal.html                      endpoint and device-token fields
└── src/
    ├── protocol.h/.cpp                  add BuildCommand for downlink JSON
    ├── wifi_wire.h/.cpp                 XL frame codec
    ├── wifi_provision.h/.cpp            submit/store endpoint settings
    └── transport_wifi.cpp               WS lifecycle, queues and callbacks

boards/rorolee-basic/
├── config.h                              physical A/B aliases
├── mediation_state.h/.cc                 pure deterministic state machine
├── pending_audio_store.h/.cc             PSRAM cache for unacknowledged segments
└── rorolee_basic.cc                      GPIO/audio/haptic integration

main/
├── Kconfig.projbuild                     Wi-Fi endpoint/token configuration
├── app_main.cpp                          pass agent_wifi_config_t and callbacks
└── CMakeLists.txt                        require cJSON where needed

test_apps/xiaoli_state/
├── CMakeLists.txt
├── sdkconfig.defaults
└── main/
    ├── CMakeLists.txt
    └── test_main.cc                      Unity tests for wire/state logic
```

### Task 1: XL binary codec and Agent Link command builder

**Files:**
- Create: `components/agent_link/src/wifi_wire.h`
- Create: `components/agent_link/src/wifi_wire.cpp`
- Modify: `components/agent_link/src/protocol.h`
- Modify: `components/agent_link/src/protocol.cpp`
- Modify: `components/agent_link/CMakeLists.txt`
- Create: `test_apps/xiaoli_state/CMakeLists.txt`
- Create: `test_apps/xiaoli_state/sdkconfig.defaults`
- Create: `test_apps/xiaoli_state/main/CMakeLists.txt`
- Create: `test_apps/xiaoli_state/main/test_main.cc`

**Interfaces:**
- Produces: `xiaoli::EncodeWireFrame(const WireFrame&, std::vector<uint8_t>&)`
- Produces: `xiaoli::DecodeWireFrame(const uint8_t*,size_t,WireFrame&)`
- Produces: `agentlink::BuildCommand(uint8_t id,uint8_t seq,const uint8_t* payload,size_t len)`

- [ ] **Step 1: Write failing Unity tests for byte equality**

```cpp
TEST_CASE("XL stream chunk encoding is byte exact", "[xiaoli_wire]") {
    const uint8_t p[] = {0x11, 0x22};
    xiaoli::WireFrame f{xiaoli::WireKind::kStreamChunk, 2, 0, 513, p, sizeof(p)};
    std::vector<uint8_t> out;
    TEST_ASSERT_TRUE(xiaoli::EncodeWireFrame(f, out));
    const uint8_t want[] = {0x58,0x4c,1,3,2,0,1,2,0x11,0x22};
    TEST_ASSERT_EQUAL_UINT8_ARRAY(want, out.data(), sizeof(want));
}

TEST_CASE("BuildCommand creates a valid Agent Link command", "[agent_link_protocol]") {
    const uint8_t json[] = {'{','}'};
    auto raw = agentlink::BuildCommand(0x7e, 9, json, sizeof(json));
    agentlink::Frame parsed;
    TEST_ASSERT_TRUE(agentlink::ParseFrame(raw.data(), raw.size(), parsed));
    TEST_ASSERT_EQUAL_UINT8(agentlink::kMsgCommand, parsed.msg_type);
    TEST_ASSERT_EQUAL_UINT8(0x7e, parsed.command_id);
    TEST_ASSERT_EQUAL_UINT8(9, parsed.sequence);
}
```

- [ ] **Step 2: Build the test app and verify failure**

Run from an activated ESP-IDF 5.4.4 shell:

```powershell
idf.py -C test_apps/xiaoli_state set-target esp32s3
idf.py -C test_apps/xiaoli_state build
```

Expected: compile failure because `wifi_wire.h` and `BuildCommand` do not exist.

- [ ] **Step 3: Implement the fixed eight-byte codec**

Define magic `0x58,0x4c`, version `1`, kinds `1..4`, stream types `0..4`, flags, sequence LE16 and payload. Reject null payload with nonzero length, frames shorter than eight bytes, wrong magic/version/kind/stream and payload above 65535 bytes.

- [ ] **Step 4: Implement `BuildCommand` beside existing response/event builders**

Reuse `WriteHeader` with `kMsgCommand`; reject sizes above `UINT16_MAX` by returning an empty vector. Do not change existing response or event bytes.

- [ ] **Step 5: Build, flash and run Unity tests**

Run:

```powershell
idf.py -C test_apps/xiaoli_state build
idf.py -C test_apps/xiaoli_state -p COM3 flash monitor
```

Expected: both test cases PASS and no reset loop. Exit monitor with `Ctrl+]`.

- [ ] **Step 6: Commit codec support**

```bash
git add components/agent_link/src/wifi_wire.h components/agent_link/src/wifi_wire.cpp components/agent_link/src/protocol.h components/agent_link/src/protocol.cpp components/agent_link/CMakeLists.txt test_apps/xiaoli_state
git commit -m "feat(agent-link): define Wi-Fi stream wire format"
```

### Task 2: Provision Bridge endpoint and device token

**Files:**
- Modify: `components/agent_link/src/wifi_provision.h`
- Modify: `components/agent_link/src/wifi_provision.cpp`
- Modify: `components/agent_link/src/transport_wifi.cpp`
- Modify: `components/agent_link/portal/portal.html`
- Modify: `main/Kconfig.projbuild`
- Modify: `main/app_main.cpp`

**Interfaces:**
- Produces: `al_prov_settings_t {ssid,password,endpoint,device_token}`
- Produces: NVS keys `ssid`, `pass`, `endpoint`, `dev_token` in namespace `al_wifi`
- Consumes: `agent_wifi_config_t.endpoint` and `.token` as first-boot defaults

- [ ] **Step 1: Add failing parse/validation tests to the Unity test app**

Extract URL validation into a pure helper `bool al_wifi_endpoint_valid(const char*)`. Test `ws://192.168.1.8:8788/device` and `ws://xiaoli-bridge.local:8788/device` as valid; reject `http://`, missing `/device`, strings above 191 bytes and empty token.

- [ ] **Step 2: Build and verify the new tests fail**

Run: `idf.py -C test_apps/xiaoli_state build`
Expected: compile failure because validation/settings APIs are absent.

- [ ] **Step 3: Replace the credential callback with a settings callback**

Change the callback to `void (*)(const al_prov_settings_t*)`. Copy all values during the callback. Increase POST body capacity to 1024 bytes; URL-decode `endpoint` and `device_token`; never log the password or token. Reject invalid endpoint/token with HTTP 400 and a short non-secret reason.

- [ ] **Step 4: Extend the captive portal**

Add required `Bridge 地址` with default `ws://xiaoli-bridge.local:8788/device` and required password-type `设备令牌`, plus a show-token checkbox. Preserve the existing Chinese/English toggle and 2.4 GHz warning.

- [ ] **Step 5: Persist settings only after Wi-Fi gets an IP**

Keep the existing rule that bad Wi-Fi credentials are never stored. On successful provisioning save SSID/password/endpoint/token in one NVS commit. On boot prefer explicit `agent_wifi_config_t` non-empty values, otherwise load NVS; if endpoint/token are missing, reopen the portal.

- [ ] **Step 6: Add menuconfig defaults without real secrets**

Under the Wi-Fi transport choice add string configs `AGENT_LINK_WIFI_ENDPOINT` defaulting to `ws://xiaoli-bridge.local:8788/device` and `AGENT_LINK_WIFI_DEVICE_TOKEN` default empty. In `app_main.cpp`, construct a static `agent_wifi_config_t` from these values and set `cfg.wifi = &wifi_cfg` only for Wi-Fi.

- [ ] **Step 7: Run tests and build the production board**

Run:

```powershell
idf.py -C test_apps/xiaoli_state build
idf.py -B build-rorolee build
```

Expected: endpoint tests PASS; production build succeeds without embedding an actual UAK.

- [ ] **Step 8: Commit provisioning changes**

```bash
git add components/agent_link/src/wifi_provision.h components/agent_link/src/wifi_provision.cpp components/agent_link/src/transport_wifi.cpp components/agent_link/portal/portal.html main/Kconfig.projbuild main/app_main.cpp test_apps/xiaoli_state/main/test_main.cc
git commit -m "feat(agent-link): provision local Bridge settings"
```

### Task 3: Non-blocking WebSocket Wi-Fi data plane

**Files:**
- Modify: `components/agent_link/idf_component.yml`
- Modify: `components/agent_link/CMakeLists.txt`
- Modify: `components/agent_link/src/transport_wifi.cpp`
- Modify: `components/agent_link/include/agent_link_transport.h`
- Modify: `test_apps/xiaoli_state/main/test_main.cc`

**Interfaces:**
- Implements: all seven `agent_transport_t` operations for Wi-Fi
- Incoming text -> Agent Link command `0x7e` -> board `on_custom`
- Incoming `AGENT_STREAM_VOICE` chunks -> `s_on_stream` -> existing `PlayAudio`

- [ ] **Step 1: Add the managed dependency**

Add to `components/agent_link/idf_component.yml`:

```yaml
  espressif/esp_websocket_client: "^1.3.0"
  espressif/mdns: "^1.4.0"
```

Run: `idf.py reconfigure`
Expected: component manager resolves a 1.x release and updates `dependencies.lock`.

- [ ] **Step 2: Write transport queue tests around an extracted queue policy**

Extract a pure `WifiTxQueuePolicy` that gives control/start/end priority over chunks, caps pending audio at 32 frames and returns `ESP_ERR_TIMEOUT` rather than dropping silently. Test ordered sequence generation, 16-bit wrap rejection during an active stream, and full-queue behavior.

- [ ] **Step 3: Resolve the local Bridge and implement WebSocket lifecycle after `IP_EVENT_STA_GOT_IP`**

If the endpoint host ends in `.local`, initialize mDNS and call `mdns_query_a` with a two-second timeout; rebuild the connection URI with the resolved private IPv4 while retaining the original port and `/device` path. If discovery fails, log a non-secret error and keep retrying; the portal's manual private-IP endpoint remains the fallback. Create the WebSocket client with network timeout 10 seconds, reconnect timeout 2 seconds, no auto-reconnect disable, and task stack large enough for fragmented events. On connect send `hello` containing protocol v1, MAC-derived `deviceId`, device name, firmware revision and device token. Do not call `s_on_conn(true)` until a valid `hello.ack` text message arrives.

- [ ] **Step 4: Implement one TX worker**

`send_ctrl`, `stream_start`, `send_stream` and `stream_end` copy data into bounded queue items and return quickly. The worker alone calls `esp_websocket_client_send_text/bin`. Control/start/end may wait up to 200 ms for queue space; audio chunks use zero wait. If an audio chunk cannot queue, return `ESP_ERR_TIMEOUT` so the board aborts the segment.

- [ ] **Step 5: Map Agent Link calls to the approved protocol**

- If `send_ctrl` receives Event `0x64`, send its UTF-8 JSON payload as WebSocket text.
- Other Agent Link frames use XL `CONTROL` binary frames.
- `stream_start` uses XL `STREAM_START`; preserve metadata bytes exactly.
- `send_stream` uses XL `STREAM_CHUNK` with per-stream sequence.
- `stream_end` uses XL `STREAM_END`, flags bit0 for complete.

- [ ] **Step 6: Implement fragmented receive handling**

Use `payload_len`/`payload_offset` to assemble a complete text or binary WebSocket message with a 64 KiB maximum. A complete text message is wrapped with `BuildCommand(0x7e,next_seq,...)` and passed to `s_on_recv`. A voice `STREAM_CHUNK` calls `s_on_stream(AGENT_STREAM_VOICE,...)`; voice `STREAM_END` generates Agent Link command `0x05` with status 3 so existing `AudioEnd` fires.

- [ ] **Step 7: Implement readiness, heartbeat and teardown**

`wifi_is_ready` is true only after Wi-Fi IP, WebSocket connected and `hello.ack`. On close call `s_on_conn(false)`, clear stream state and queues, and reconnect with capped backoff. `wifi_stop` must stop timers, WebSocket client, TX worker, portal and Wi-Fi without use-after-free.

- [ ] **Step 8: Build and run a mock-Bridge transport test**

Start the Bridge protocol test server on the PC, flash production Wi-Fi firmware, provision endpoint/token, and verify serial order: Wi-Fi IP -> WS connected -> hello.ack -> Agent state READY. Stop Bridge and verify DISCONNECTED followed by a successful reconnect.

- [ ] **Step 9: Commit the Wi-Fi data plane**

```bash
git add components/agent_link/idf_component.yml components/agent_link/CMakeLists.txt components/agent_link/include/agent_link_transport.h components/agent_link/src/transport_wifi.cpp test_apps/xiaoli_state/main/test_main.cc dependencies.lock
git commit -m "feat(agent-link): implement WebSocket Wi-Fi transport"
```

### Task 4: Pure mediation state machine

**Files:**
- Create: `boards/rorolee-basic/mediation_state.h`
- Create: `boards/rorolee-basic/mediation_state.cc`
- Modify: `test_apps/xiaoli_state/main/CMakeLists.txt`
- Modify: `test_apps/xiaoli_state/main/test_main.cc`

**Interfaces:**
- Produces: `MediationStateMachine::Handle(const Event&): ActionBatch`
- Produces: states `kWelcome,kWaiting,kRecordingA,kRecordingB,kMediating,kPlaying,kRecoverableError`
- Produces: action types `kNewCase,kStartRecording,kStopRecording,kRequestMediation,kVibrate,kShowStatus,kNone`

- [ ] **Step 1: Write the complete failing state-transition tests**

Tests must cover:

1. GPIO0 short release creates a case but never starts recording.
2. GPIO0 held 2999 ms does not mediate; 3000 ms emits exactly one request.
3. GPIO40 toggles only A recording; GPIO39 toggles only B recording.
4. Opposite key during recording leaves the state unchanged and emits `kVibrate` for 120 ms.
5. Long press while recording emits stop-before-mediate actions in that order.
6. Mediation is rejected until at least one completed segment exists for each side.
7. `audio.end` returns playing to waiting without clearing counts.
8. A new short GPIO0 case clears both counts.
9. A Bridge segment ACK shows `A发言结束` or `B发言结束`; a timer event at 4999 ms keeps the end message, while 5000 ms returns to `小理开始倾听` without blocking the task.

- [ ] **Step 2: Build and verify tests fail**

Run: `idf.py -C test_apps/xiaoli_state build`
Expected: compile failure because mediation state files do not exist.

- [ ] **Step 3: Implement a heap-free deterministic state machine**

Use fixed-size `ActionBatch` with at most four actions. The state machine owns only state, stable button times, long-press fired flag, completed A/B counts and the non-blocking five-second status deadline; it does not call GPIO, Agent Link, codec or FreeRTOS APIs. Status strings are exactly `欢迎来到小理天秤官`, `小理开始倾听`, `小理开始倾听A发言`, `小理开始倾听B发言`, `A发言结束`, `B发言结束`, `小理调解中` and the explicit error messages from the design.

- [ ] **Step 4: Run Unity tests on COM3**

Run:

```powershell
idf.py -C test_apps/xiaoli_state build
idf.py -C test_apps/xiaoli_state -p COM3 flash monitor
```

Expected: all eight transition scenarios PASS.

- [ ] **Step 5: Commit the state machine**

```bash
git add boards/rorolee-basic/mediation_state.h boards/rorolee-basic/mediation_state.cc test_apps/xiaoli_state/main/CMakeLists.txt test_apps/xiaoli_state/main/test_main.cc
git commit -m "feat(rorolee): add A/B mediation state machine"
```

### Task 5: Integrate physical buttons, microphone and haptic motor

**Files:**
- Modify: `boards/rorolee-basic/config.h`
- Create: `boards/rorolee-basic/pending_audio_store.h`
- Create: `boards/rorolee-basic/pending_audio_store.cc`
- Modify: `boards/rorolee-basic/rorolee_basic.cc`
- Modify: `main/board.h`
- Modify: `main/app_main.cpp`
- Modify: `main/CMakeLists.txt`
- Modify: `test_apps/xiaoli_state/main/CMakeLists.txt`
- Modify: `test_apps/xiaoli_state/main/test_main.cc`

**Interfaces:**
- Consumes: approved physical pin map, mediation state actions, `agent_link_asr_*`, `agent_link_push_event`
- Produces: custom JSON `case.start` and `mediate.request`; recording metadata for A/B segments
- Produces: `PendingAudioStore` retaining at most two unacknowledged 60-second PCM segments in PSRAM

- [ ] **Step 1: Add unambiguous physical aliases**

Keep the verified volume pin constants, then add:

```cpp
#define BUTTON_PERSON_A_PIN GPIO_NUM_40  // physical left key
#define BUTTON_PERSON_B_PIN GPIO_NUM_39  // physical right key
```

Add compile-time assertions that A and B differ and neither equals GPIO0.

- [ ] **Step 2: Replace the old GPIO0 PTT loop with one mediation task**

Configure GPIO0/40/39 together as active-low pull-up inputs. Poll every 10 ms; feed debounced press/release and monotonic milliseconds to the pure state machine. While recording, read 320 samples per 20 ms and call `agent_link_asr_push`.

- [ ] **Step 3: Add a bounded PSRAM pending-audio store**

Create `pending_audio_store.h/.cc`. Allocate two buffers with `heap_caps_malloc(1'920'000, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)`, enough for two 60-second PCM16/16k/mono statements. Cache every captured PCM frame before attempting WebSocket send. Keep case/segment/speaker metadata and sent/ack state. If both slots are occupied or one statement exceeds 60 seconds, stop recording, mark an explicit capacity error, vibrate and never silently truncate.

Add Unity tests with an injected small allocator/buffer that prove: bytes survive a simulated disconnect; ACK frees exactly one matching segment; duplicate ACK is harmless; the oldest unacknowledged segment is replayed first; capacity overflow returns an error without overwriting another speaker's segment.

- [ ] **Step 4: Generate deterministic IDs and metadata**

Build IDs from the device MAC suffix plus monotonic case/segment counters. On recording start call `agent_link_asr_start` with JSON containing protocol v1, `speech.start`, `messageId`, `caseId`, `segmentId`, `speaker`, and fixed audio format. On stop call `agent_link_asr_end(true)` only if every PCM push succeeded; otherwise call `agent_link_asr_end(false)`.

- [ ] **Step 5: Send case and mediation JSON events**

Use `agent_link_push_event(AGENT_EVT_CUSTOM,...)` for `case.start` and `mediate.request`. Each JSON includes `v`, `type`, unique `messageId` and `caseId`. If the link is not READY, do not start the mic; show/log a recoverable network error.

- [ ] **Step 6: Route Bridge JSON into a queue and release only acknowledged audio**

Add `virtual void HandleCustom(uint16_t,const uint8_t*,size_t)` to `Board`, implement the `app_main.cpp` `on_custom` adapter, and register it in `agent_output_cb_t`. `RoRoLeeS3Board::HandleCustom` copies payloads into a bounded FreeRTOS queue and returns immediately. The mediation task parses JSON with cJSON and handles `ack`, `state`, `transcript.saved`, `audio.start`, `audio.end` and `error`; malformed or oversized messages are rejected without changing state. A segment buffer is freed only after `ack.segmentId` confirms Bridge wrote a complete WAV locally.

- [ ] **Step 7: Replay unacknowledged segments after reconnect**

When Agent Link returns READY, iterate pending segments oldest-first. For each, reopen `agent_link_asr_start` with the original metadata, resend cached PCM in 640-byte frames, and end complete. Bridge deduplicates the same `segmentId`. Block new recordings while both pending slots are occupied; permit one new recording when one slot is free.

- [ ] **Step 8: Implement real non-blocking haptic output**

Configure GPIO1 output low during board initialization. `Vibrate(ms)` sets it high and starts/restarts a one-shot `esp_timer`; the timer callback sets it low. Clamp duration to `20..3000` ms and never block a transport callback.

- [ ] **Step 9: Keep playback non-blocking and make status observable**

Retain the existing stream buffer and speaker task. Log every business state with `caseId`/`segmentId` but no transcript. Map waiting/recording/mediating/playing/error to distinct haptic patterns. Continue calling `ShowText`; when the panel is black, serial/haptic remain authoritative.

- [ ] **Step 10: Build production firmware**

Run: `idf.py -B build-rorolee build`
Expected: build succeeds for `rorolee-basic`; no warnings about undefined A/B pins or blocking callback use.

- [ ] **Step 11: Commit board integration**

```bash
git add boards/rorolee-basic/config.h boards/rorolee-basic/pending_audio_store.h boards/rorolee-basic/pending_audio_store.cc boards/rorolee-basic/rorolee_basic.cc main/board.h main/app_main.cpp main/CMakeLists.txt test_apps/xiaoli_state/main/CMakeLists.txt test_apps/xiaoli_state/main/test_main.cc
git commit -m "feat(rorolee): connect physical mediation controls"
```

### Task 6: Firmware smoke, recovery and completion gate

**Files:**
- Modify: `README.zh-CN.md`
- Modify: `docs/hardware-rorolee-basic-verified.zh-CN.md`
- Test: production firmware on COM3

**Interfaces:**
- Produces: verified firmware ready for end-to-end Agent integration

- [ ] **Step 1: Restore and build the production configuration after Unity tests**

Run:

```powershell
idf.py -B build-rorolee menuconfig
idf.py -B build-rorolee build
```

Confirm Board Type `rorolee-basic`, Transport `WiFi`, endpoint `ws://xiaoli-bridge.local:8788/device`, and a device token set locally in ignored `sdkconfig`.

- [ ] **Step 2: Flash and capture a bounded boot log**

Run: `idf.py -B build-rorolee -p COM3 flash monitor`
Expected: chip ESP32-S3, verified board name, Wi-Fi IP, WebSocket `hello.ack`, Agent state READY, speaker and haptic initialized.

- [ ] **Step 3: Verify physical position mapping without cloud calls**

With mock Bridge connected: press physical left and confirm `speaker=A/GPIO40`; press again to end. Press physical right and confirm `speaker=B/GPIO39`; press again to end. Press GPIO0 short and confirm new case; hold for three seconds and confirm one mediation request only.

- [ ] **Step 4: Verify disconnect recovery**

Stop Bridge during idle, confirm DISCONNECTED/error haptic, restart Bridge, and confirm READY without reboot. Stop Bridge during recording; confirm current stream ends incomplete and is never reported as a saved transcript.

- [ ] **Step 5: Run firmware/build hygiene checks**

Run:

```powershell
git diff --check
git grep -n -E "ag9_(uak|wak)_[A-Za-z0-9_-]{12,}|Authorization:[[:space:]]*Bearer[[:space:]]+[A-Za-z0-9_-]{12,}" -- .
```

Expected: no whitespace errors; secret scan returns no matches.

- [ ] **Step 6: Update hardware/run documentation and commit**

Document exact physical positions, GPIOs, COM3, Wi-Fi portal fields, endpoint, device token handling, mock Bridge test, black-screen limitation and how to restore production firmware after the Unity test app.

```bash
git add README.zh-CN.md docs/hardware-rorolee-basic-verified.zh-CN.md
git commit -m "docs(rorolee): document Wi-Fi mediation firmware"
```
