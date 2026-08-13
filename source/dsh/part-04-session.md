# 第四篇　会话日志（事件溯源）
*作者：Amlei　·　更新时间：2026-08-13*

`dsh` 的会话（`Session`）是一条 **append-only 的事件日志**。这条日志是 agent 交互的唯一真相源——LLM 看到的消息历史不是存储对象，而是从日志**派生**（`deriveMessages()`）出来的投影。这一篇讲清这条日志的词汇、投影规则和它支撑的几条不变量。

源码在 `packages/core/session/`，核心是 `index.ts`（约 1150 行）、`surface.ts`（surface 投影管理）、`types.ts`（事件类型）、`json.ts`（无损 JSON 校验）、`request-header.ts`。

## 第 1 章　为什么是 append-only 事件日志

直接存一个 `Message[]` 看似简单，但它是**有损的运行时快照**——无法回放重建。只有日志（含 turn/step 边界、原始 chunk、tool/call 的原始 arguments、request/header）才能让"任何一个请求都是日志的纯函数"。

这带来一条贯穿全系统的铁律：

> **Model-visible ⟺ logged.**（模型可见的东西，一定能从日志重建。）

每个产生 message 的事件必须带 `surfaceOp`（见第 3 章），surface 只接受带标记的事件。落盘日志等于内存 surface 的底料，因此持久化可以直接逐字存储日志（见[第八篇](part-08-persistence.md)）。

另一个全局契约是：**seq 必须连续，等于 log.length，包含 chunk**。

```ts
// packages/core/session/src/index.ts:525-527
if (snapshot.seq !== index) {
  throw new Error(`seed event at index ${index} has seq ${snapshot.seq} (expected ${index}); seed must be contiguous from 0`)
}
```

chunk（流式 token 块）虽然不进 surface、不投影成 message，但它**占 seq 且永不 filter**——否则持久化回放会错位。这条连续性还让 `chunk-rows.ts` 的**存储压缩**可逆：`packChunkRuns` 把 ≥3 个连续同类 chunk 压成一行，展开时用 `seq0 + k` 重建每个成员的 seq。

## 第 2 章　SessionEventMap：14 个核心事件，可合并扩展

```ts
// packages/core/session/src/types.ts:236-333（节选）
export interface SessionEventMap {
  'turn/start': { turn: number }
  'turn/end': { turn: number; reason: TurnEndReason }
  'step/start': { turn: number; step: number }
  'step/end': { turn: number; step: number }
  'user/message': UserMessage
  'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
  'assistant/message': { turn: number; step: number; message: AssistantMessage; usage?: TokenUsage }
  'tool/call': { turn: number; step: number; callId: CallId; name: string; arguments: string }
  'tool/result': { turn: number; step: number; message: ToolResultMessage; error?: {...}; meta?: JsonValue }
  'todo/write': { todos: TodoItem[] }
  'request/header': { header: EpochHeader; reason: RequestHeaderReason }
  'request/context': RequestContext
  'session/end-seed': Record<string, never>
}
```

插件通过声明合并扩展（`compaction/*`、`hook/*`、`approval/*`、`goal/*` 等，见 `known-event-types.ts` 的 44 个已知类型）。`ignorable?: true` 标记让旧 runtime 遇到未知事件时可安全跳过；默认是 required——**宁可过度拒绝，也不静默吞掉**。

### 2.1　SessionEvent：对 `type` 的判别联合

```ts
// packages/core/session/src/types.ts:404-436（节选）
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K; seq: number; time: number; data: SessionEventMap[K]; ignorable?: true
  } & (K extends SurfaceEventType ? { sourceEventSeqs?: number[]; surfaceOp?: SurfaceOp } : object)
}[T]
```

这是一个**对 `type` 的判别联合**（不是独立的 `type`/`data` 联合），所以 `switch (event.type)` 直接 narrow `event.data`，无需 cast。`sourceEventSeqs`/`surfaceOp` 是**条件字段**——只在 `SurfaceEventType` 上存在，编译器在 `append()` 调用点强制。

### 2.2　SessionHeader：日志之外的存储元数据

```ts
// packages/core/session/src/types.ts:61-99（节选）
export interface SessionHeader {
  readonly version: number              // = SESSION_FORMAT_VERSION = 0
  readonly id: SessionId
  readonly createdAt: number
  readonly cwd?: string                 // 必须绝对路径
  readonly parentSession?: SessionId    // fork 血统
  readonly seedLength?: number          // 继承的前缀事件数
  readonly delegationDepth?: number     // 递归预算，跨 restart 存活
  readonly agentPreset?: string         // 决定 tools + prompt
}
```

header **不在日志里**（是存储关注点，不是可回放的对话状态）。`delegationDepth`/`agentPreset` 必须持久化——resume 后 depth 不能重置成 top-level（见[第十篇](part-10-subagent.md)），preset 不能换成别的 composition（否则回放的历史模型无法再行动）。`SESSION_FORMAT_VERSION = 0` 是单一单调整数；增加普通事件类型不 bump，只有结构性变更才 bump。

## 第 3 章　Surface：消息历史的唯一来源

只有三种事件产生 LLM message、能进有序 surface、能携带 `sourceEventSeqs`：`user/message`、`assistant/message`、`tool/result`（合称 `SurfaceEventType`）。它们带一个 `SurfaceOp`：

```ts
// packages/core/session/src/types.ts:343-374
export type SurfaceOp =
  | 'append'
  | { op: 'replace'; start: number; end: number }
```

`append` 是尾部追加；`replace{start,end}` 用本节点替换 surface 中 `[start,end]` 闭区间的节点——这是上下文压缩用的（见[第九篇](part-09-compaction.md)），任何 surface 替换型 producer 都可用。

### 3.1　append 的单次递归 pass

`Session.append` 在一次遍历里同时做"校验 + 深拷贝 + 冻结"，防止有状态的 getter 给校验和存储两个不同的值（TOCTOU）：

```ts
// packages/core/session/src/index.ts:604-655（append 主体，节选）
append<T>(type, data, ...opts): SessionEvent<T> {
  const dataSnapshot = snapshotJsonValue(data)               // 单次 pass：校验 + 深拷贝
  if (dataSnapshot === undefined) throw new Error(`...non-JSON-serializable data`)
  ...
  const event = deepFreeze({ type, seq: this.log.length, time: Date.now(), data: dataSnapshot, ...surfaceMetadata })
  this.surfaceManager.validateNext(event)                    // 先校验 surface 再提交
  ... this.log.push(event) ... invokeContainedSessionObservers('session/event') ...
}
```

`snapshotJsonValue`（`json.ts`）是迭代式（非递归，不爆栈）的单遍，拒绝：BigInt、function、symbol、undefined、负零（`Object.is(current, -0)`）、非有限数、循环引用、稀疏数组、Map/Set/Date（原型须是 intrinsic）。跨 realm 检查用 `Function.prototype.toString.call(constructor) === 'function Array() { [native code] }'` 防伪造原型。校验失败不污染 surface（`validateNext` 在 `log.push` 之前）。

### 3.2　deriveMessages：投影规则与缓存

surface 是消息历史的唯一来源；每个 surface node 投影一次后缓存，surface rewrite 时重建。

```ts
// packages/core/session/src/index.ts:701-747（节选）
deriveMessages(): Message[] {
  const surface = this.surface
  if (surface.replaceGeneration !== this.derivedGeneration) {
    this.derived = []; this.derivedNodes = 0; this.derivedGeneration = surface.replaceGeneration
  }
  for (const seq of surface.nodes.slice(this.derivedNodes)) {
    const msg = this.deriveEventMessage(this.log[seq]!)
    if (msg) this.derived.push(msg)
  }
  this.derivedNodes = surface.nodes.length
  return [...this.derived]                                  // 每次调用返回新数组
}
```

`deriveEventMessage` 是 `surface.ts` 的 **public 纯函数**（dev invariant 和外部重建用同一规则，不会矛盾）。投影规则：

- `user/message` → `event.data`（content 原样透传，含注入的 context）。
- `assistant/message` → `event.data.message`，**但空 content 返回 null**——max-tokens step 可能只产出 usage 而无 content，注入一个空 assistant turn 会让 provider transcript 非法。
- `tool/result` → `event.data.message`。
- 其它（含 `assistant/chunk`、turn/step 边界）→ null。

非显然：返回 `[...this.derived]` 是**新数组**，但里面的 `Message` 对象**共享且深冻结**——复用已冻结的 durable event data，缓存无需二次深拷贝，消费者也无法篡改日志。

### 3.3　为什么 chunk 被跳过

`assistant/chunk` 是 token 级回放保真数据，**不是 message**——它落到 `deriveEventMessage` 的 `default → null`。message 由 `assistant/message`（组装后的）单独投递。但 chunk **必须**占连续 seq（见第 1 章），否则压缩行回放不出来。

> **知识补充：usage 与 message 同行。** 模型调用的 token 计费（`usage`）跟在 `assistant/message` 上，**没有单独的 usage 记录**。max-tokens 截断无 content 的 assistant/message 仍 append 进日志带着 usage——它给 token-meter 当锚点，但因其 content 为空，`deriveMessages` 跳过它，所以它不进 provider transcript。

### 图 1　事件分类树

```
SessionEvent（对 type 的判别联合）
├── SurfaceEventType（可携带 surfaceOp + sourceEventSeqs）
│   ├── user/message        → deriveMessages: event.data
│   ├── assistant/message   → deriveMessages: event.data.message（空 content → null）
│   └── tool/result         → deriveMessages: event.data.message
└── log-only（default → null）
    ├── turn/start · turn/end · step/start · step/end   （边界，不变量校验嵌套）
    ├── assistant/chunk      （token 回放，永不 filter，占 seq，可压缩）
    ├── tool/call            （原始 arguments 字符串，callId 配对）
    ├── todo/write           （UI 状态，last-write-wins）
    ├── request/header       （最新 snapshot 重建 EpochHeader）
    ├── request/context      （route capacity，单独 fold）
    └── session/end-seed     （种子边界，constructor 唯一写者）
    [+ 插件 merge: compaction/* · hook/* · approval/* · goal/*]
```

## 第 4 章　SurfaceManager：先校验后提交

surface 的增量维护用"plan-then-apply"两阶段：`validateNext` 产 `_pendingPlan`（已校验但未提交），candidate 失败不会部分改变 surface。提交时用已校验的 plan 直接 apply，不重复校验。

```ts
// packages/core/session/src/surface.ts:362-379
function applySurfacePlan(state, plan) {
  if (plan?.kind === 'append') state.nodes.push(plan.seq)
  else if (plan?.kind === 'replace') {
    state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq)
    state.replaceGeneration += 1                              // 只有 replace 才递增 generation
  }
}
```

`replaceGeneration` 是单调计数——它让 `deriveMessages` 能区分"纯尾增长"（缓存可增量扩展）与"重写"（缓存要重建）。`foldSurface` 还会返回 `shadowedSeqs`（被替换的真实节点列表，供审计/重建）。

> **tool/result replace 受限。** `assertToolResultRewrite` 强制 tool/result 的 surface replace 只能重写**恰好一个**当前 tool/result 节点，且**只能改 content**——这是给 tool-result 剪枝用的约束（见[第九篇·第 4 章](part-09-compaction.md)）。

## 第 5 章　turn/step 边界为什么是持久事件

turn/step 边界是**关系型不变量**（turn 嵌套、step 归属、pending tool/call 配对），必须跨 crash/replay 可校验。invariant companion（`invariant.ts`）在 `session/event` 上验证这些关系。若边界只在 agent 内存里，crash 后无法重建校验。

```ts
// packages/core/session/src/invariant.ts:71-113（节选）
case 'turn/start': {
  if (trace.openTurn !== null) fail(`turn/start ${event.data.turn} while turn ${trace.openTurn} is still open`)
  if (event.data.turn !== trace.nextTurn) fail(`turn/start expected turn ${trace.nextTurn}, got ${event.data.turn}`)
  openTurn = event.data.turn; nextStep = 1; break
}
case 'step/end': {
  requireOpenStep(trace, 'step/end', ...)
  pendingCalls = { kind: 'clear' }   // step 结束清空 pending calls
  openStep = null; nextStep += 1; break
}
```

invariant 用两阶段（`validateEvent` 产 transition，`session/event` 时 `applyTransition`）应对"later dispatch listener may veto"。

> **tool/call 存原始未解析 arguments 字符串。** `tool/call` 存模型产出的**原始 JSON 字符串**（unparsed），不解析成对象。原因：(1) 回放保真——模型可能产出非法 JSON，解析会丢信息；(2) `tool/call` 与 `tool/result` 通过 `callId` 配对；(3) crash 恢复需要原始 callSeq 来 cite 合成 result（见[第八篇·第 2 章](part-08-persistence.md)）。

## 第 6 章　request/header：请求包络是日志状态

请求包络（`EpochHeader`：call config + adapter 物化的默认值 + 渲染的 system prompt + 组装的工具 schema）是**日志状态**，所以每次 conversation request 都是日志的纯函数。

```ts
// packages/core/session/src/request-header.ts:65-71
export function foldRequestHeader(events, from?): EpochHeader | undefined {
  let state = from
  for (const event of events) if (event.type === 'request/header') state = canonicalHeader(event.data.header)
  return state
}
```

`canonicalHeader` 把空 system / 空 tools 归一成**缺席字段**（匹配 request 构建方式）。循环用 `headerEquals` 逐字段比较，避免记录未变化的 header——只记 `initial`/`resume`（每实例边界）和 `change`（变了才记）。

`request/context` 故意**不**进 `EpochHeader`——capacity 描述 route 而非 request input，fold 进去会让 capacity 变化被误判为 request-envelope `change`，并把 adapter 元数据拖进循环的重建不变量。`session.requestContext()` 单独增量 fold。

### 6.1　requestProposal 剥离 adapterDefaults

`agent-loop` 把 adapter 物化的字段（`adapterDefaults.reasoningEffort === true` 等）从 header.config 里**删掉**再给 plugin 提议——防止 plugin 把 adapter 默认值当成"用户显式选的"固化（见[第十一篇](part-11-llm.md)）。

## 第 7 章　session/end-seed：种子边界

一个 seeded session（resume/fork/replay）在构造种子之后追加一个 `session/end-seed` 事件，作为它的第一条 live 写入。`firstLiveSeq` 是**进程内**事实（本进程 append 的第一个 seq = 构造种子长度），不持久化；它的 durable 投影就是 `session/end-seed` 事件。

为什么需要它？因为种子历史和 live 工作在字节上**无法区分**。一个独立的 `compaction/start … compaction/end` 开闭括号的 owner 读它——此事件之前的**未闭合** opening marker 必属一个已结束的生命周期（无论怎么结束的），所以孤儿 `compaction/start` 的判定靠它（见[第九篇·第 5 章](part-09-compaction.md)）。

两个非显然纪律：locate **LAST** 个 `session/end-seed`，而非假定它在 `firstLiveSeq`（种子可能已以它结尾，重开未触碰的 session 不应增长日志）；constructor 是唯一合法写者，invariant 对它**故意不约束**。

## 第 8 章　fork：inclusive boundary，拒绝 open-turn 前缀

```ts
// packages/core/session/src/index.ts:1097-1138（_forkSeed，节选）
private _forkSeed(session, requestedBoundary): SessionEvent[] {
  ... boundary = requestedBoundary ?? lastEvent.seq ...
  const lastTurnBoundary = events.slice(0, boundary + 1)
    .findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  if (lastTurnBoundary?.type === 'turn/start') {
    throw new SessionForkError(..., 'OPEN_TURN')   // 拒绝，不裁剪
  }
  return events.slice(0, boundary + 1)             // inclusive boundary
}
```

`boundary` 是闭区间上界 seq。省略 = source 当前最后事件；空 source 省略 = 空 child。**拒绝 open-turn 结尾前缀而非裁剪**——切在未闭合 turn 中间抛 `OPEN_TURN`，不自动回退到上一个 `turn/end`。静默裁剪会丢用户已看到的工作。

deep-clone seed + child metadata（`parentSession` + `seedLength`）。子 agent 的委派 fork 保留 completed-prefix clipping（见[第十篇·第 5 章](part-10-subagent.md)）。

### 图 2　surface append vs replace 的节点演化

```
日志 seq          surface.nodes          replaceGeneration
0: turn/start{1}  []                     0
1: user/append    [1]                    0
2: user/append    [1,2]                  0
3: asst/append    [1,2,3]                0
4: user/replace   splice(0,2,4) → [4,3]  1  ← generation++
   (srcSeqs=[1,2])  节点 1,2 被 shadowed
   deriveMessages 检测 generation 变 → 清缓存全量重建 → 投影 [4,3] = [summary, asst-reply]
```

## 权衡总账

- **append-only 日志**的代价是写放大（每个 chunk 都进日志）和投影开销。收益是 resume/fork/压缩/transcript/telemetry 全从同一日志派生，"模型可见 ⟺ 已记录"让历史永远可重建。
- **seq 含 chunk 连续**牺牲了一点存储空间，换来 chunk 压缩行的可逆性。
- **surface replace 而非删 event**让日志真正 append-only（永不删），surface 投影变。代价是 `shadowedRange` 是 position span 而非 seq 区间（替换后 seq 非单调，`start` 可能 `>` `end`），权威集合是 `shadowedSeqs`。
- **tool/call 存原始字符串**牺牲了一点解析便利，换来回放保真和 crash 恢复的精确 cite。
- **header 不进日志**把"存储元数据"与"可回放对话状态"分开，代价是消费者要分清两者，收益是日志保持纯粹的对话事件流。

（持久化如何把这条日志落到 JSONL/SQLite，以及 crash 恢复如何合成 `interrupted` closer，见[第八篇](part-08-persistence.md)；surface replace 如何被压缩用来折叠历史见[第九篇](part-09-compaction.md)。）
