# DSH Superagent 消息召回与捕获策略

- Status: proposed
- Scope: `examples/dsh-memory-plugin` 与 `examples/memory-plugin-shared`
- Target host: DeepSeek Harness 0.2.1-rc.3
- Target deployment: dsh-superagent（下称 SA），主会话 `dsh-superagent-router`，Worker `dsh-superagent-worker`
- 当前状态：SA 尚未安装 `@openviking/dsh-memory-plugin`；本文描述安装并接入后的目标行为。

## 背景

OpenViking 的 DSH 记忆插件目前只把 `source.kind` 缺失或为 `user` 的消息当作可召回输入，并且把非 `user`/`tool` 的合成 user 消息排除在捕获之外。这个规则适合普通 DSH 会话，但不适合 SA：

- SA 的候选卡、Worker 报告、结束通知等由 `AgentDelivery` 投递，`source.kind` 为 `dsh-superagent`。
- SA 主会话输入以合成消息为主；UI 仍可直接输入，但日常流程几乎都走合成消息。
- SA Worker 会话不是 subagent；`skipSubagentSessions` 无法区分 Worker。
- SA 的 Worker assignment 只在首个 assignment 中带完整文本；后续 assignment 只有 ticket 计数和可选 note。
- SA 当前没有安装 OV 记忆插件；spec 需要同时写清插件侧与 SA 侧的前置条件。

如果原样使用插件，主会话召回基本不会触发，主会话候选/报告不会进入捕获，而 Worker 输出可能被捕获，得到的是不完整的记忆。

## 决策

在 DSH 记忆插件中增加两个相互独立的策略：

1. **召回策略**：先解析 SA 合成消息的 JSON body，再按 predicate 选择是否召回。
2. **捕获策略**：不解析 JSON，只按 source kind 决定是否把原始消息交给原生 capture 流程。

策略不放在 DSH 的 `cordis.patch.yml` 中，因为 DSH config schema 只支持 bool/int/number/enum/string/list/template；嵌套对象会被静默丢弃。

改为**实例级 JSON 策略文件**：

```text
<stateDir>/ov-memory-policy.json
```

例如：

```text
/home/ubuntu/.dsh/state/superagent/ov-memory-policy.json
```

插件从 SA 的 `orchestrator` 服务读取实例的 `stateDir`：

```text
ctx.get("orchestrator", false)?.machine?.stateDir
```

非严格读取允许在 orchestrator 仍处于 LOADING 时拿到服务；stateDir 在每次 recall/capture 时重新解析，不用会话创建时的空值永久缓存。

然后固定读取：

```text
<stateDir>/ov-memory-policy.json
```

不按 session cwd 搜索，不按安装目录推导，不向父目录 fallback。文件不存在时按空策略处理；解析失败或版本不兼容时按空策略处理并记录 warning。

文件变化时，下一次 `agent/pre-step` / `session/event` 重新读取，不需要重启。

## 两种处理必须分开

### 召回：解析 body

召回需要理解消息结构，因此：

```text
content 中第一个 `type = text` 的 part
→ 按 JSON 解析成 body
```

规则：

- 解析失败：不召回。
- `body.*` 只检查顶层字段，不递归。
- 只使用用户/任务文本构造查询，不使用内部 JSON 原文。

predicate：

| predicate | 匹配条件 | 召回查询文本 |
|---|---|---|
| `candidate` | `source.kind = dsh-superagent`，`source.form = relay`，`body.kind = candidate` | `body.text` |
| `follow_up` | `source.kind = dsh-superagent`，`source.form = relay`，`body.kind = follow_up` | `body.text` |
| `worker_assignment` | `session.header.agentPreset = dsh-superagent-worker`，`source.kind = dsh-superagent`，`body.ticket_id` 和 `body.trigger` 存在 | 依次拼接 `body.title`、字符串 `body.assignment`（若存在）、`body.trigger.text`；没有可用的 assignment/trigger 文本时不召回 |
| `worker_follow_up` | `session.header.agentPreset = dsh-superagent-worker`，`source.kind = dsh-superagent`，`source.form = relay`，`body.trigger_id` 和字符串 `body.text` 存在 | `body.text`；`body.context = true` 的 context-only 卡，以及 `body.from` 为空的自动通知卡，不召回 |

限制：

- `worker_assignment` 只匹配第一条带 `ticket_id + trigger` 的 worker 输入；后续 assignment 计数没有可用的用户文本，不召回。首次 assignment 可能没有 `assignment` 字段，此时用 `trigger.text` 构造查询。
- `worker_follow_up` 匹配的是后续消息的 trigger 卡；它只有 `trigger_id`、`from`、`thread`、`at`、`text` 等字段，没有 `ticket_id`、`kind` 或首条 assignment 的 `trigger` 对象。context-only 卡是订阅线程的旁听消息，`from` 为空的卡是 GitHub CI 等自动通知，二者都不进入 query。`body.text` 短于 `minQueryLength` 时同样不召回。
- `worker_report`、`worker_attention`、`ticket_ended`、settings/prompt/thread notice 不召回。
- 原生 user/assistant/tool 的召回行为不变。

### 捕获：不解析 body

捕获不解析 JSON，也不加 provenance 头、不改 role、不做特殊整形。

只改过滤条件：

```text
source.kind = dsh-superagent
→ 放行到现有 capture 流程
```

其余由现有 capture 逻辑处理：

- text part 整形
- tool result 处理
- 长度截断
- role 固定为 `user`
- 不保留 `source.kind` / `source.form`

所以：

- JSON 解析失败不影响捕获；只要消息进入 session log，仍交给原生 capture。原生 capture 的 sanitize、ACK/short 过滤和长度截断仍生效。
- 捕获后的 OV 消息仍是 `user`，无法区分合成消息与真人消息；这是 OV 原生行为，不是本次新增的特殊格式。
- 捕获所有进入 session log 的 `source.kind = dsh-superagent` 合成 user 消息。
- 未被 claim 的 `agent.inject` 不会产生 `user/message` 事件，也就不会被捕获。

## 策略文件格式

```json
{
  "version": 1,
  "recall": [
    {
      "match": {
        "source": { "kind": "dsh-superagent", "form": "relay" },
        "body": { "kind": "candidate" }
      }
    },
    {
      "match": {
        "source": { "kind": "dsh-superagent", "form": "relay" },
        "body": { "kind": "follow_up" }
      }
    },
    {
      "match": {
        "session": { "agentPreset": "dsh-superagent-worker" },
        "source": { "kind": "dsh-superagent", "form": "relay" },
        "body": { "has": ["ticket_id", "trigger"] }
      }
    },
    {
      "match": {
        "session": { "agentPreset": "dsh-superagent-worker" },
        "source": { "kind": "dsh-superagent", "form": "relay" },
        "body": { "has": ["trigger_id", "text"] }
      }
    }
  ],
  "capture": [
    {
      "match": {
        "source": { "kind": "dsh-superagent" }
      }
    }
  ]
}
```

匹配语义：

- `source.kind`、`source.form` 精确匹配。
- `body.kind` 只在 body 顶层存在该字段时匹配。
- `body.has` 只检查顶层字段是否存在，不构造字段。
- `session.agentPreset` 用于区分 Worker assignment 与 Worker follow-up。
- 召回：命中任一 recall rule 即允许；未命中默认拒绝。
- Worker follow-up 的 `body.text` 只在 `body.context` 不为 true 且 `body.from` 非空时进入 query。
- 捕获：命中任一 capture rule 即允许；未命中默认拒绝。
- 不使用 deny，不依赖规则顺序。

## 条目语义

这里的名称是 SA 原始消息中的字段或结构名，不是插件新造的扁平类型。

| 条目 | 语义 |
|---|---|
| `candidate` | 新的外部请求候选卡。来自飞书/GitHub 等 Source，交给主会话评估是否接单；body 含用户原文、Thread、来源和强度。 |
| `follow_up` | 对已有话题的人工追问。不是新请求，而是补充说明、追问或继续讨论。 |
| `worker_assignment` | 主会话派给 Worker 的任务。首个 worker 输入的 body 含 ticket_id、标题和来源 Trigger；有些还带 assignment 文本。后续 assignment 只有 ticket_id、assignment 计数和可选 note。没有扁平 kind 字段。 |
| `worker_follow_up` | 工单开始后由人发在 Thread 上、作为 Ticket Input 送达 Worker 的 trigger 卡。body 含 trigger_id、from、thread、at、text；没有 kind、ticket_id 或嵌套 trigger。context-only 卡额外带 `context: true`。 |
| `worker_report` | Worker 回给主会话的状态/结果报告。state 为 progress、waiting、ready、blocked、failed 或 dropped；progress 只在回答追问时转发；summary 上限约 600 字。 |
| `worker_attention` | Worker 向人提问的 relay。body 含 ticket 卡（含 `attention.question`）、state 和 read 路径；问题正文已在卡内。 |
| `ticket_ended` | 工单结束通知。form 为 `notice`；ticket 仍存在时 body 含 ticket_id、title、state、ended.at/by/reason；ticket 不在 store 时只有 ticket_id、by、outcome、reason、at。没有 Worker 摘要或改动内容。 |
| `trigger_requeued` | Trigger 被重新排队的通知。只有 trigger id 和 read 路径，没有业务正文。 |
| `settings_saved` | 设置保存/变更通知。只是配置变更元数据，没有任务内容。 |
| `prompt_config_saved` | Prompt 配置保存通知。只是版本/变更元数据。 |
| `thread_followed` | Ticket 开始关注某个 Thread 的通知，用于上下文，不授予权限。 |
| `thread_unrelated` | Executor 判断某个 Thread 与 Ticket 无关的通知。 |
| `subscription_changes` | Thread 订阅被移除等订阅变更通知。 |

原生 DSH 消息：

| 条目 | 语义 | 当前行为 |
|---|---|---|
| native `user` | 真人直接输入。 | 召回 + 捕获，现有规则不变。 |
| native `assistant` | 模型输出。 | 捕获，不召回，现有规则不变。 |
| native `tool` | tool/call 与 tool/result。 | 按 `captureToolResults` 捕获，不召回，现有规则不变。 |
| subagent assignment | 父 agent 派给 subagent 的任务，kind 为 `agent-message`。 | 当前不召回、不捕获；本次不改变。 |

## 需求

### R1：实例级策略文件

- 插件从 `ctx.get("orchestrator", false)?.machine?.stateDir` 取实例状态目录；`SourceHost.stateDir` 是 SA 提供的稳定访问器。
- stateDir 在每次 recall/capture 时重新解析，不缓存会话创建时的空值。
- 固定读取 `<stateDir>/ov-memory-policy.json`；不搜索 cwd，不推导安装目录，不 fallback。
- 文件不存在时按空策略处理；解析失败、版本不支持时按空策略处理并记录 warning，不阻塞原生行为。
- 文件变化后下一次 pre-step/session event 重新读取。
- 不使用 DSH config schema，不扩展 KNOBS，不新增生成目标。

### R2：召回先解析 body

- 召回 predicate 只读取解析后的 body 顶层字段。
- JSON 解析失败时不召回。
- `candidate`、`follow_up` 使用 `body.text`。
- 首个 `worker_assignment` 使用 `body.title`、字符串 `body.assignment`（若有）、`body.trigger.text`。
- 没有 assignment 但有 trigger 的 worker 输入也要召回。
- 后续 assignment 计数不召回。
- `worker_follow_up` 使用不含首尾空白的 `body.text`；`body.context = true` 与 `body.from` 为空的卡不召回。

### R3：捕获不解析 body

- 捕获只按 `source.kind` 放行。
- 不解析 JSON，不加 provenance 头，不改 role，不做特殊整形。
- 走现有 `captureEvent` / `captureMessage` / `shapeCapturePayload`。
- 捕获所有进入 session log 的 `source.kind = dsh-superagent` 合成 user 消息。

### R4：Worker 与 subagent

- 不新增按 preset 跳过记忆的逻辑。
- 不设置 `skipSubagentSessions`。
- Worker 与 subagent 的捕获默认保留。
- 原生 subagent assignment 是 `agent-message`，当前不召回、不捕获；本次不改变。
- Worker assistant/tool 输出捕获，不召回。

### R5：MCP 工具面

插件始终挂载完整 OV MCP 工具面；`mcpEnabled` 是未读取的空开关，不作为本次决策。

SA 侧前置配置：

1. `~/.dsh/profiles/superagent` 增加 `@openviking/dsh-memory-plugin` 依赖，并在 bundles 或 `cordis.patch.yml` 加一条插件条目；策略文件路径由插件自动查找，不写进 DSH config。只在 profile 根挂一次，不要在两套 preset 里各挂一次。
2. SA 的 `dsh-superagent` 配置增加 `mcpToolAllowlist`，例如 `["mcp__openviking__"]`；entry 以 `__` 结尾时按前缀匹配，否则按精确工具名匹配。
3. `superagent-bootstrap/src/app/sessions.ts` 的主 Session allow 名单、`WORK_TOOLS`、Worker/Subagent allow 名单，都要包含该配置筛选出的 MCP 工具。
4. DSH `restrict` 只接受精确名；用 `agent.ctx.tools.schemas(parent)` 枚举后按 `mcpToolAllowlist` 过滤，不要手写 49 个工具名。
5. 验收时在 Router Session 和 Worker Session 中各调用一次 `mcp__openviking__` 工具并拿到结果。

当前 SA 代码已实现第 2、3 项；第 1 项是部署步骤，测试实例已安装，生产 profile 尚未安装。

### R6：tool result 捕获

`captureToolResults: true` 是 DSH 下既有默认，不是本次决策。  
体积主要来自 tool result，`captureToolMaxChars` 默认 1,000,000。

### R7：提交策略

`commitTokenThreshold: 20000` 是既有默认，不引入 SA 特殊值。服务端自动提交作为兜底。

### R8：不改变 peer 语义

不新增静态 `peerId`，不要求仓库内 `.openviking/config.json`，不新增 `workspacePeer` 覆盖。  
peer 继续遵循插件现有的 workspace peer 解析；SA 侧不为此增加特殊配置。

### R9：默认行为兼容

策略文件不存在或两个策略为空时，插件行为必须与当前版本一致：

- 合成消息不召回
- 合成消息不捕获
- 原生 user/assistant/tool 行为不变
- MCP、skills、profile、commit、peer 行为不变

## 非目标

- 不改 OV 服务端的过滤、提取或记忆结构。
- 不改 SA 的 prompt、路由、工具语义，只改工具 allow 名单与 profile 组合。
- 不解析 `ticket/<id>/result` 等 SA 资源，捕获内容止于消息正文。
- 不引入 deny 规则，不做消息类型归一。
- 不新增静态 peerId，不要求仓库内配置文件。
- 不改变原生 user/assistant/tool 的召回与捕获。
- 不把 notice 当作 turn 边界。
- 不改变原生 subagent 的消息处理。
- 不新增 provenance 头或伪造 system role。

## 验收标准

1. 策略文件不存在时，现有测试全部通过，行为与当前版本一致。
2. 策略文件解析失败时，记录 warning，合成消息不召回、不捕获，不抛异常。
3. `candidate` 命中后产生一次 OV 召回；`worker_report` 不触发召回。
4. `follow_up` 命中后产生召回。
5. 首个 `worker_assignment` 命中后产生召回，包括没有 assignment 但有 trigger 的变体；后续 assignment 计数不召回。
6. `body` JSON 解析失败时，召回不触发；捕获不受影响，仍按原文进入 session log。
7. 所有 `source.kind = dsh-superagent` 的合成 user 消息被捕获，包括 `ticket_ended`、settings/prompt notice。
8. 捕获时 role 仍为 `user`，不保留 source/kind，不添加 provenance 头。
9. `ticket_ended` 被捕获，但不触发召回；它不被当作 turn 边界。
10. MCP 工具始终挂载；SA 按前缀放行后，Router 与 Worker 各能调用一次 `mcp__openviking__` 工具。
11. `captureToolResults: true` 时 tool 调用/结果仍按现有逻辑捕获。
12. peer 行为与当前插件一致，不新增静态 peer 或仓库配置文件依赖。

## 考虑过的方案

### 方案 A：放 DSH config schema

不采用。schema 不支持嵌套对象列表，嵌套配置会被静默丢弃；扩展 schema 还要同步生成目标、doctor 与 workspace 校验，超出最小改动范围。

### 方案 B：自定义实例级 JSON 策略文件

采用。保留嵌套 selector，可热读取，不影响 DSH config schema，不要求每个仓库配置文件。

### 方案 C：按扁平 kind 归一

不采用。候选卡、follow-up、Worker 报告、assignment、`ticket_ended` 的字段和生命周期不同，归一化会丢失结构，后续新增类型也会被迫进入同一个类型。

### 方案 D：代码硬编码 candidate/follow_up

不采用。用户需要按实际记忆质量调整召回/捕获范围，硬编码会导致每次调整都要改插件代码。

### 方案 E：默认跳过 Worker/subagent

不采用。当前目标先保留 Worker/subagent 捕获，观察抽取价值；默认跳过会丢失实际执行侧的经验。

### 方案 F：只挂 MCP，不改召回/捕获

不采用。SA 的输入是合成消息，原版过滤逻辑下主会话召回和捕获不会正确工作。

## 影响

正面：

- SA 主会话能得到跨会话、跨实例的候选上下文。
- Worker assignment 的首个任务文本可召回。
- Worker/subagent 的实际执行结果可进入 OV。
- 全捕获 `dsh-superagent` 保证注入上下文与后续 turn 连续。
- 召回仍保持精确，噪音小于全量召回。
- 策略文件可独立调整，不改 DSH config，不改代码。

代价：

- `settings_saved`、`ticket_ended` 等低实质内容 notice 会进入 OV，产生噪音。
- 捕获后 role 固定为 user，且不保留 source/kind，OV 无法区分合成消息与真人消息。
- `ticket_ended` 与 Worker report 有部分重复。
- Worker/subagent 捕获会增加 OV 的 session 数据量和抽取成本。
- 体积主要来自 tool result，不是合成消息。
- 插件版本需要升级；本策略不修改 DSH config schema，也不新增 shared 生成目标。
