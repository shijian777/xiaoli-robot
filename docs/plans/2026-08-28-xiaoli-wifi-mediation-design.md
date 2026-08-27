# 小理天秤官：D 板 Wi-Fi 本机调解系统设计

**日期：** 2026-08-28
**状态：** 已由用户逐节确认
**目标硬件：** ROROLEE-Basic（ESP32-S3，16 MB Flash，8 MB PSRAM）
**开发仓库：** `D:\Agent_link`
**本机串口：** `COM3`

## 1. 目标与范围

小理天秤官让争议双方通过实体按键明确身份，分别完成多轮陈述，再由云端 Agent 生成中立、温和、可执行的调解意见，并通过 D 板扬声器播放。

第一阶段不经过固定的 ROROLEE App，采用以下闭环：

```text
D 板按键与麦克风
  -> 同一局域网内的 Wi-Fi / WebSocket
  -> Windows 本机 Node.js Bridge
  -> TiDB Agent Stack 音频 Turn 与文本 Turn
  -> Windows 中文 TTS
  -> Wi-Fi PCM 下行
  -> D 板 ES8311 扬声器
```

本设计只覆盖本机 Bridge MVP 与比赛可演示闭环。公网部署、移动 App、长期案件管理和修复当前黑屏硬件不属于第一阶段阻塞项。

## 2. 已验证硬件事实

本机实物以 `rorolee-basic` 板型为准，不使用 `rorolee-s3` 的不同引脚表。

| 实际位置或能力 | 定义 | 验证状态 |
|---|---:|---|
| 侧边独立键 | GPIO0 | 已验证；短按创建案件，长按 3 秒请求调解 |
| 实物左键 | GPIO40 | 已验证；固定代表 A |
| 实物右键 | GPIO39 | 已验证；固定代表 B |
| 扬声器 PA | GPIO3 | 已验证可播放 |
| 震动马达 | GPIO1 | 已验证可震动 |
| 麦克风 | ES7210 / I2S DIN GPIO12 | 已验证可录音 |
| 播放 Codec | ES8311 / 16 kHz | 已验证 |
| 串口 | COM3 | 已验证 |
| AMOLED | SH8501 120x240 | 当前保持黑屏，作为已知限制 |
| SD 卡 | SDIO | 无卡，未验证 |

业务代码必须用“实物左键/实物右键”描述身份，不能用易混淆的音量加减名称决定 A/B。

## 3. 架构与职责

### 3.1 D 板

- 处理三个实体按键、消抖、短按和长按。
- 采集 16 kHz、16-bit、单声道 PCM。
- 给每段音频附加 `caseId`、`segmentId` 和确定性 `speaker=A|B`。
- 通过 WebSocket 上传控制 JSON 和二进制音频帧。
- 接收状态 JSON、文字提示与 16 kHz PCM 下行。
- 负责扬声器、震动与可用时的屏幕反馈。
- 不保存 Agent Stack UAK、登录密码或任何云端管理凭据。

### 3.2 本机 Bridge

- 监听本机 `8788` 端口，并通过 mDNS 广播 `xiaoli-bridge.local`。
- 认证设备共享令牌；令牌只存在于本机环境文件和设备 NVS/menuconfig。
- 对设备控制消息去重、确认和恢复。
- 把 PCM 音频片段封装为标准 WAV。
- 串行或有界并发执行转写，按 A/B 保存文字。
- 为每个案件创建独立调解 Session。
- 校验 Agent 的结构化输出。
- 调用 Windows `System.Speech` 中文语音，以 16 kHz 单声道 PCM 回传。
- 默认不记录完整陈述到普通日志；原始临时 WAV 在转写完成后删除。

### 3.3 TiDB Agent Stack

系统使用两个职责隔离的 Agent：

1. **转写 Agent**：音频 Turn 只返回忠实转写 JSON，不判断说话者、不总结、不调解。
2. **小理调解 Agent**：文本 Turn 接收 Bridge 已标注的 A/B 多段文字，返回结构化调解结果。

UAK 仅由 Bridge 通过环境变量读取。现有聊天中暴露过的密码和 UAK 在正式调用前必须轮换；仓库、截图、串口日志和演示材料不能出现任何真实密钥。

## 4. 设备业务状态机

主要状态：

```text
BOOT
  -> WELCOME
  -> CASE_IDLE
  -> RECORDING_A | RECORDING_B
  -> SEGMENT_QUEUED
  -> CASE_IDLE
  -> MEDIATING
  -> PLAYING
  -> CASE_IDLE
```

错误状态可以从任意联网或云端阶段进入 `ERROR_RECOVERABLE`，恢复后回到保留当前案件的 `CASE_IDLE`。

### 4.1 按键规则

- GPIO0 按下后在松开时判断：小于 3 秒为短按；达到 3 秒只触发一次长按。
- GPIO40 在 `CASE_IDLE` 启动 A 录音，在 `RECORDING_A` 结束 A 当前片段。
- GPIO39 在 `CASE_IDLE` 启动 B 录音，在 `RECORDING_B` 结束 B 当前片段。
- 录音时按另一方键不切换人物，忽略该输入并短震动提示。
- 所有机械按键采用约 40 ms 稳定电平消抖。

### 4.2 案件规则

- 短按 GPIO0 清空旧案件，生成新 `caseId`，进入等待状态。
- 每次发言生成唯一 `segmentId`；同一段重传不得重复累计。
- 音频完整到达 Bridge 并进入转写队列后，设备提示“A/B 发言结束”五秒。
- 转写在 Bridge 后台排队，不阻止下一段录音。
- 长按 GPIO0 时如仍在录音，先正常结束并提交当前片段。
- Bridge 等待案件内所有已接收片段转写完成后才调用调解 Agent。
- A 或 B 完全没有有效文字时拒绝启动调解，并提示先收集双方发言。
- 播放结束后保留案件；双方可补充，再次长按生成新版意见。
- 下一次短按 GPIO0 才结束并清除当前案件。

## 5. WebSocket 应用协议

业务控制内容使用 UTF-8 JSON；高吞吐音频使用二进制帧。底层 WebSocket 保证单连接内有序可靠传输，应用层通过 ID、序号和确认消息实现断线恢复和幂等。

### 5.1 设备上行 JSON

```text
hello             设备编号、固件版本、令牌和能力
case.start        创建案件
speech.start      caseId、segmentId、speaker、音频格式
speech.end        字节数、最后序号和完整性信息
mediate.request   请求调解
```

`speech.start` 元数据必须包含：

```json
{
  "v": 1,
  "type": "speech.start",
  "messageId": "device-unique-message-id",
  "caseId": "case-id",
  "segmentId": "segment-id",
  "speaker": "A",
  "audio": {"sampleRate": 16000, "bits": 16, "channels": 1}
}
```

### 5.2 Bridge 下行 JSON

```text
hello.ack          认证和协议协商完成
ack                messageId 或 segmentId 已可靠接收
state              waiting/recording/transcribing/mediating/playing/error
transcript.saved   指定 A/B 片段转写完成
audio.start        下行 PCM 参数
audio.end          播放结束
error              错误码、是否可重试和简短提示
```

### 5.3 二进制帧

Agent Link Wi-Fi 传输使用固定外层头，避免把 PCM 转成 Base64：

| 偏移 | 长度 | 字段 |
|---:|---:|---|
| 0 | 2 | Magic `XL` (`0x58 0x4c`) |
| 2 | 1 | 协议版本 `1` |
| 3 | 1 | `kind`: control/start/chunk/end |
| 4 | 1 | Agent Link `streamType` |
| 5 | 1 | flags，bit0 表示 complete |
| 6 | 2 | little-endian sequence |
| 8 | N | payload |

录音 `stream_start` 的 payload 是上述 `speech.start` JSON；录音 chunk 的 payload 是原始 PCM。下行 TTS 使用 `AGENT_STREAM_VOICE`。每段流的序号从 0 开始递增，Bridge 检测缺帧后拒绝将不完整音频送去 ASR。

## 6. Agent 输入与输出

### 6.1 转写 Agent

固定返回：

```json
{
  "transcript": "转写文字",
  "unclear": false
}
```

规则：忠实转写；不判断 A/B；不总结；听不清用 `[听不清]`；不能猜测内容。

### 6.2 调解 Agent 输入

```json
{
  "caseId": "案件编号",
  "A": [
    {"index": 1, "text": "A 第一段陈述"},
    {"index": 2, "text": "A 补充陈述"}
  ],
  "B": [
    {"index": 1, "text": "B 第一段陈述"}
  ],
  "requirements": {
    "neutral": true,
    "noWinner": true,
    "language": "zh-CN"
  }
}
```

### 6.3 调解 Agent 输出

```json
{
  "conflictSummary": "矛盾核心",
  "aPosition": "A 的立场与诉求",
  "bPosition": "B 的立场与诉求",
  "aCanImprove": "A 可以改善的地方",
  "bCanImprove": "B 可以改善的地方",
  "commonGround": "双方共同点",
  "suggestions": ["建议一", "建议二"],
  "spokenText": "适合设备直接播放的调解话术"
}
```

约束：不宣布输赢；区分事实、感受和诉求；不机械五五开；`spokenText` 以约一分钟播放为上限；只有通过 JSON Schema 校验的文字才能进入 TTS。涉及暴力威胁、自伤、虐待或紧急危险时停止普通调解，优先给出安全求助建议。

## 7. ASR、TTS 与降级

- Agent Stack `/api/sessions/{id}/turns/audio` 接收完整 WAV，而不是通用实时音频流。
- Bridge 逐行解析 NDJSON，只有看到成功的 `assistant_message` 和 `turn_finished` 才接受结果。
- 如果音频 Turn 返回 `501`，切换到本机 `faster-whisper` 中文转写；备用模型默认 `small`、CPU `int8`。
- Windows TTS 使用已检测到的 `Microsoft Huihui Desktop`，明确请求 16 kHz、16-bit、单声道 WAV，不依赖 ffmpeg。
- TTS 失败时保留文字结果；屏幕可用则显示，屏幕仍黑时通过错误震动和串口提示。

## 8. 数据、安全与日志

- `.env.local`、真实 UAK、账号和密码永不提交。
- 固件只保存 Wi-Fi、Bridge endpoint 和设备令牌，不保存 UAK。
- Bridge 日志默认只含案件/片段 ID、状态、耗时、HTTP 状态与脱敏错误码。
- 原始 WAV 在成功转写或明确失败处理后删除。
- 当前案件文字保留到用户短按创建下一案件；Agent Stack Session 按平台策略保存。
- Agent 输出只能驱动白名单动作：状态文字、震动时长和播放音频；不能生成任意 GPIO 命令。

## 9. 错误处理

| 故障 | 设备与 Bridge 行为 |
|---|---|
| Wi-Fi/Bridge 不可用 | 短震动错误提示，保留未确认片段并有上限重连 |
| 缺失音频帧 | 不转写，标记片段失败并要求重录 |
| Agent 超时或 5xx | 遵守 `Retry-After` 或有抖动的有限重试一次 |
| Agent Stack ASR 501 | 自动调用本机 Whisper |
| Agent 返回非法 JSON | 拒绝 TTS；文本 Turn最多请求一次结构修复 |
| TTS 失败 | 保存调解文字并返回明确错误状态 |
| 屏幕黑屏 | 语音、震动和串口作为比赛闭环保底 |

## 10. 验收标准

1. 不打开 ROROLEE App 也能完成一次真实语音调解。
2. A/B 各录制两轮，Bridge 的案件记录仍按实体左右键正确分类。
3. 录音时按另一方按键不会切换或混入错误身份。
4. 长按 GPIO0 后播放的是动态生成的中文调解，而不是固定测试音。
5. 扬声器完整播放约一分钟 16 kHz PCM，不出现明显丢块。
6. WebSocket 断开并恢复后，已确认片段不重复，未确认片段可重发。
7. 连续演示至少三次成功。
8. `git grep`、日志、README 和截图不存在账号、密码、UAK 或设备真实令牌。
9. README 包含环境、配网、Bridge、Agent、编译、烧录、COM3 与最短验证路径。

## 11. 资料依据

- 赛前 D 板与 Wi-Fi 说明：<https://tidb-pre-match-intro-dct7ede.gamma.site/>
- 赛道与交付要求：<https://tidb-ai-hardware-hacktho-ect1jik.gamma.site/>
- Agent Stack 参赛指南：<https://tidb-agent-stack-intro-avsk9wk.gamma.site/>
- Agent Stack Developer Kit：<https://github.com/mem9-ai/agent-stack-dev-guide>
- Agent Stack OpenAPI：<https://raw.githubusercontent.com/mem9-ai/agent-stack-dev-guide/main/references/openapi.yaml>
- 官方硬件 Bridge 示例：<https://github.com/you06/esp32-agent-lcd>
- ESP WebSocket Client：<https://components.espressif.com/components/espressif/esp_websocket_client>
