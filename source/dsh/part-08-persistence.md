# 第八篇　会话持久化
*作者：Amlei　·　更新时间：2026-08-13*

[第四篇](part-04-session.md) 讲了内存里的 `Session`——一条 append-only 的事件日志。这一篇讲这条日志如何**落到磁盘**：抽象的 `SessionPersistence` 接缝、它的两个后端（JSONL / SQLite）、flush checkpoint 的去抖、以及崩溃恢复如何合成 `interrupted` closer。

源码在 `packages/session/session-persistence/`（抽象 + coordinator）、`-jsonl/`、`-sqlite/`。

## 第 1 章　为什么持久化是接缝

内存 `Session` 是 append-only 日志，是权威。持久化被**刻意外移到 plugin**——"Persistence is intentionally not implemented here — plugins subscribe to `session/event`"（`packages/core/session/README.md`）。接缝是一个抽象 service 定义（locate/create/append/...），多个可互换后端实现同一契约。结果：session 包不耦合任何磁盘格式。

### 1.1　没有平行的 persisted event type

coordinator 直接 import 现成的 `SessionEvent`，`appendBatch` 吃的就是 `readonly SessionEvent[]`。**zero schema drift**——不存在"持久化事件 vs 内存事件"两套要同步的词表。

### 1.2　为什么两个后端

覆盖两种物理介质。JSONL：append-only 一文件一会话，顺序介质，可 `readRaw` 拿逐字字节。SQLite：`node:sqlite`，一库多会话，可按 seq seek。两者都通过共享的 `runPersistenceContract` 测试。

### 1.3　Revision：轻量源修订

backend 拥有的 opaque token，transactionally 变化于 append 或 mutating load repair。caller 只比较相等性。两个 backend 不可比：JSONL 用 `dev:ino:size:mtimeNs:ctimeNs`，SQLite 用 `storeIdentity:incarnation:X:revision:Y`，`storeIdentity` 塞了文件 `dev:ino:birthtimeNs:store_id` 让不同库的计数器绝不相等。

## 第 2 章　崩溃恢复：不截断 turn，合成 closer

崩溃留下的的日志有一个 `turn/start` 无匹配的 `turn/end`。恢复策略**不截断**（一个长 horizon turn 可能巨大且都已持久化），而是合成 closer。

```ts
// packages/core/session/src/repair.ts:78-132（节选）
const closers = []
// 1. 给未匹配 tool-call 合成 error tool/result（区分 started/未 started 两套文案）
for (const [callId, { step, callSeq }] of pendingCalls) {
  closers.push({ type: 'tool/result', seq: seq++, time, data: { /* isError, code TOOL_OUTCOME_UNKNOWN / TOOL_NOT_STARTED */ } })
}
// 2. 合成缺失 step/end（step/end 是 turn 内不变量，须在 turn/end 前）
if (openStep !== null) closers.push({ type: 'step/end', seq: seq++, time, data: { turn: openTurn, step: openStep } })
// 3. turn/end{reason:{kind:'interrupted'}}  ← interrupted 是循环从不 emit 的唯一 TurnEndReason
closers.push({ type: 'turn/end', seq: seq++, time, data: { turn: openTurn, reason: { kind: 'interrupted' } } })
```

`interrupted` 是循环**从不 emit** 的唯一 `TurnEndReason`——它是 recovery 的专属标记。timestamp 复用最后真实事件的时间（确定性，不发明"未来"时间）。

> **只丢 torn final record。** tornMarker 由各 backend 自己定义（JSONL = `{truncateTo, recoveredEvents}`；SQLite = 删除起点 seq）。JSONL 从 torn zstd 帧尽力 `decompressZstdPrefix` 抢救完整 records，committed 之前的全保留。

### 2.1　只对 cold session

恢复只对 cold session（磁盘上、无 live agent 的）。live id 走另一条路：

```ts
// packages/session/session-persistence/src/coordinator.ts:974-985（loadLiveSnapshot，节选）
private async loadLiveSnapshot(session) {
  await this.flush(session)                       // 等到 in-memory snapshot durable
  if (interruptedTurnClosers(events).length > 0) {  // open live turn → 拒绝
    throw new Error(`cannot load session "${session.id}" while its live turn is open; use the live Session or wait for the turn to close`)
  }
  return Object.freeze({ meta: state.meta, events })
}
```

load(live) 等当前 snapshot durable 且 balanced 才返回；open live turn **拒绝**而非合成 interruption。

### 图 1　crash recovery 前后日志对比

```
CRASHED 日志（turn 2 中途, tool/call 无 result）:
  header
  turn/start{1} ... turn/end{1,reason:completed}
  turn/start{2}
    step/start{0}
    assistant/message{tool-call:A}, {tool-call:B}
    tool/call{callId:A}            ← A 已 record started
  ── crash，EOF 在 zstd 帧中间 ──   ← tornMarker 记录 tornStart

load() 后（in-memory balanced；commitRepair 持久化）:
  ... 同上 ...
    [torn tail 字节被 truncate]                      ← 只丢 torn record
    tool/result{callId:A, isError, code:TOOL_OUTCOME_UNKNOWN, srcSeqs:[tool/call.seq]}  ← A started
    tool/result{callId:B, isError, code:TOOL_NOT_STARTED}                                ← B 未 started
    step/end{2,0}
    turn/end{2, reason:{kind:'interrupted'}}    ← 循环从不 emit 的唯一 reason
```

## 第 3 章　flush checkpoint batching

流式响应短时间内发大量 `assistant/chunk`，逐条 durable append 会导致写放大。去抖成 batch，给个**固定上限**。

### 3.1　生产者侧不阻塞

```ts
// packages/session/session-persistence/src/coordinator.ts:1123-1126
ctx.on('session/event', (session, event) => {
  const live = this.initFor(session)
  live.writes.enqueue(event)   // structuredClone 进 per-session controller，立即返回
})
```

### 3.2　固定窗口（不重置 deadline）

```ts
// packages/session/session-persistence/src/write-behind.ts:45-56
enqueue(event) {
  const wasEmpty = this.pending.length === 0
  this.pending.push(structuredClone(event))
  if (this.barrier !== undefined) return
  if (this.automaticPaused) { this.automaticPaused = false; this.deadlineExpired = false; this.armTimer() }
  else if (wasEmpty) { this.armTimer() }   // 空队变非空才 arm timer，后续不碰
}
```

`wasEmpty` 守卫 = bounded coalescing（有界合并），**不是 debounce**（debounce 会被持续流推迟到无限）。

### 3.3　expiry 启 durable batch；期间 admitted 的 event 收自己 deadline

deadline 到时若 active write 在跑，置 `deadlineExpired`；active 完成后 `continueAutomatic` 看标志立即启下一批。"超预算" = active write 占用了下一批的预算窗口，完成后立即补跑（不重新等一个完整窗口）。

### 3.4　flush 取消等待 + drain 到 quiescence

```ts
// packages/session/session-persistence/src/write-behind.ts:118-136（drainBarrier，节选）
private async drainBarrier(resolve, reject) {
  const overlapping = this.active
  if (overlapping !== undefined) { await Promise.allSettled([overlapping]); this.automaticPaused = false }
  while (this.pending.length > 0) await this.startWrite(false)
  this.barrier = undefined; resolve()
}
```

关键：`this.barrier = undefined` 在**观察到空队列的同一 job** 里、`resolve` 之前关闭 admission，这样迟来的 enqueue 不会被困在已 settle 的 barrier 后面，而是开自己的新窗口。

### 3.5　rejected 背景 write：保留 event + 暂停自动重试

```ts
// packages/session/session-persistence/src/write-behind.ts:138-158（节选）
const active = operation.catch((error) => {
  this.pending = batch.concat(this.pending)   // 按序回灌到队首
  this.automaticPaused = true                  // 暂停 timer 驱动重试
  if (background) this.options.reportBackgroundFailure(error)  // 只报告一次
  throw error
})
```

新 event enqueue 看到 `automaticPaused` 就开**fresh 窗口**；显式 `flush`（非 background）则**立即重试**并把失败抛给 caller。coordinator 的 `reportBackgroundFailure` 只 `logger.warn`，从不成 session event 流过已关的 turn。

**checkpoint policy 在三处调 `ctx.sessions.flush`**：`llm/stream`（首 chunk 前）、`tools/execute`（top-level tool body 前）、`agent/pre-step`（前置响应/结果批）——把 flush 当 ordering + error-observation 屏障。`writeBatchMaxDelayMs` 默认 200ms，只 bound **intentional batching wait**，不 bound event-loop 调度或 backend I/O。

## 第 4 章　prepare / load / inspect 三态

三态共享同一套 preparation 机器（`preparations.ts` 的 pool），区别在 commit + publish 程度：

- **prepare**：`reserve` → `commitPrepared`（提交 repair）→ 返回 disposable `SessionPreparation`。
- **load**：同样 `reserve` + `commitPrepared`，完成后 `discard`（不发布）。
- **inspect**：用 `inspect`（非 reserve）——**不 commit repair、不发布**。cold 时构造 immutable logical Session（内存平衡 interrupted turn，物理 torn tail 不动）；live 时借当前 immutable snapshot（可含 open turn）。

LRU 缓存（`preparations.ts:285-298`，capacity 5）：重复 history 读 + 后续 `prepare` 共享**一次** read/解压/校验/freeze/construct。phase 机：`loading → ready → committing → reserved`。revision retry 用一次 read/check round trip 收敛；continuous external writer 延迟收敛。

### 图 2　三态流程

```
prepare(id) → reserve → commitPrepared(提交 repair) → 返回 SessionPreparation(Disposable)
load(id)    → reserve → commitPrepared(提交 repair) → discard(不发布)
inspect(id) → inspect(非 reserve)
              ├─ cold: 构造 immutable logical Session(内存平衡 interrupted turn, 物理不动, 不 commit)
              └─ live: inspectLive 借当前 snapshot(可含 open turn + session/end-seed 边界)
readFrom(id, fromSeq) → 纯物理 suffix 读, 无 pool/无 truncation/无 closer/无 publication
```

## 第 5 章　JSONL 后端

- **append-only 一文件一会话**：`session.jsonl.zstd`（默认）或 `session.jsonl`，路径 `root/<projectKey>/<encodedId>/session.<suffix>`。`encodeSegment` 对 SessionId 做 injective 路径转义——SessionId 是 unvalidated branded string。
- **checksummed concatenated Zstandard 帧**：每帧开 `ZSTD_c_checksumFlag`；`scanZstdFrames` 不解压逐块定位完整帧，EOF 在末帧内返回 `tornStart`；header 单独一帧。
- **crash-safe 原子写用 link+unlink 非 rename**：

```ts
// packages/session/session-persistence-jsonl/src/index.ts:529-569（节选）
const tmp = await this.writeSyncedTempFile(finalPath, content)   // O_EXCL(wx) + fsync
let linked = false
try { await link(tmp, finalPath); linked = true }               // link 遇 EEXIST 失败，两进程并发 materialize 同 id 不互踩
finally { if (!linked) await rm(tmp, { force: true }) }
await this.syncDirPosix(dir)                                     // fsync 目录，新 link 才 crash-durable
```

- **chunk-rows packed 编码**：`packChunkRuns` 把连续 `assistant/chunk` delta 打包成 storage rows（约 -60%）。**读是无条件 layout-blind**（`decodeStorageRecord`），所以日志布局不依赖写开关。
- **foreign version 从 raw header line 直接拒绝**：`refuseForeignFormatVersion` 在 `isHeaderLine` shape 校验之前抛 `SessionFormatUnsupportedError`——未来格式可能根本不满足今天 header shape，必须报"upgrade"非"corrupt"。

## 第 6 章　SQLite 后端

- **一行一 SessionEvent**，1:1 字段映射（`session_id, seq, type, time, data, source_event_seqs, surface_op, ignorable`）STRICT 表。每个 mutating transaction `revision+1`。`appendBatch` 和 `commitRepair` 都是单事务（原子性 + durability 边界 = 事务）。
- **SCHEMA_VERSION pragma gate 整文件结构**：`PRAGMA user_version` 必须是 0（空库）或 `SCHEMA_VERSION`；还有 `application_id` gate 防误打开无关库。journal_mode 默认 wal。
- **readFrom(fromSeq) 按 seq seek 只读 suffix**；JSONL 无此 hook，coordinator 回退 `readStoredPrefix` parse 整 artifact 再 `slice(fromSeq)`——primitive bound 的是 RETURN + refold，非每 backend 物理读。

## 第 7 章　格式拒绝：方向性消息

```ts
// packages/session/session-persistence/src/coordinator.ts:77-81
export function sessionFormatVersionRefusal(id, version) {
  return version > SESSION_FORMAT_VERSION
    ? `... written by a newer harness — upgrade the harness to open it`
    : `... older than the supported v${SESSION_FORMAT_VERSION}, and this build ships no upgrade path for it`
}
```

`SessionFormatUnsupportedError`（log 完好但本 build 无法忠实解读）vs `SessionPersistenceCorruptionError`（durable 内容校验失败）。格式版本不匹配是**方向感知拒绝**——更新 log = "upgrade the harness" 非 "corrupt"。未知事件类型默认 required：`assertEventsSupported` 对不在 `KNOWN_SESSION_EVENT_TYPES` 且无 `ignorable: true` 的事件拒绝——**忘标 marker = over-refuse（大声拒）而非静默吞**。

## 权衡总账

- **持久化是接缝**让 session 包不耦合磁盘格式，但要求两个后端都通过 `runPersistenceContract`——一致性测试成本。
- **不截断 interrupted turn**牺牲了一点恢复复杂度（要合成 closer），换来长 horizon turn 的真实历史不丢——`interrupted` 是 recovery 专属标记。
- **flush batching 用 bounded coalescing 非 debounce**让持续流不被无限推迟，但 `writeBatchMaxDelayMs` 只 bound intentional wait——部署选小值 = 窄丢失窗口，大值 = 强 batching。
- **prepare/load 共用 commit-repair 机器**，区别只在 publish——但 inspect 是唯一不 commit、不发布的路径（cold 只内存平衡）。readFrom 是正交的物理 suffix 读维度。
- **JSONL 用 link+unlink 非 rename** 实现原子写，避免两进程并发 materialize 同 id 互踩——代价是 Win32 需要独立的 write-through namespace 操作。
- **格式拒绝 over-refuse 默认**（未知事件类型不静默跳过）牺牲了向前兼容的"宽容"，换来回放正确性——静默跳过未知 required 事件会重构出错误 session。

（session log 的事件词汇与派生见[第四篇](part-04-session.md)；compaction 如何用 surface replace 见[第九篇](part-09-compaction.md)；session-query 如何读这条日志见[第十四篇·第 8 节](part-14-ecosystem.md)。）
