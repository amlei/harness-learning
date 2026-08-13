# 第三篇　Agent 循环（turn / step）
*作者：Amlei　·　更新时间：2026-08-13*

这一篇讲 `dsh` 的核心驱动——`agent-loop`。它是把"一条用户输入"变成"一段模型与工具的往返、并把它写进会话日志"的发动机。理解了它，就理解了一个 agent 在 `dsh` 里到底怎么"跑起来"。

源码在 `packages/core/agent-loop/`（驱动器与工厂）和 `packages/core/agent/`（Agent 接口、注册表、inbox）。`agent-loop` 是**唯一具体的循环实现**——它依赖 `agent` 层（`ctx.agents`/Agent 接口），而非反过来；扩展插件依赖 `agent`，永不直接依赖 `agent-loop`，所以循环本身可替换。

## 第 1 章　turn 与 step

`dsh` 把一个 agent 的活动分成两层：

- **step（步）** = 一次模型请求，加上它调用的那些工具的执行。
- **turn（回合）** = 零个或多个 step：它在第一条输入被领取（claim）之前打开，在"什么都不欠"时关闭。

一个 turn 可以含 0 个 step（首批输入被拒、或被清空时，仍写一个空的平衡 turn）、1 个 step（模型直接完成）、或多个 step（模型反复调工具，直到没有工具调用、或某个工具结果带 `concludesTurn`）。一个 step 可以含**多次模型请求**——失败的请求可经 `agent/request-error` waterfall 重试。

```ts
// packages/core/agent-loop/src/index.ts:296-298
export class AgentLoop extends Service implements AgentFactory {
  static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']
```

`agent-loop` 硬依赖这五个 service（Cordis 的 `inject` 是硬依赖）。而 `dsh-agent` 包**不依赖** `agent-loop`——`AgentRegistry` 只持有一个 `AgentFactory` 接口槽。循环通过 `ctx.agents.setFactory(this)` 把自己注册成工厂，注册是 effect 作用域的，卸载即清槽。消费者（如 ACP 桥）只编程到 `ctx.agents`，不知道 `agent-loop` 的存在。

## 第 2 章　turn 的结束由"数据"决定

`agent/turn-stopping` 是一个 serial 事件，但它是否真的让 turn 结束，由**之后重新读取的 inbox 数据**决定，不是 listener 的返回值：

```ts
// packages/core/agent-loop/src/agent.ts:295-300
if (turnEnds && this.inbox.nextStep.length === 0) {
  await this.dispatch.serial('agent/turn-stopping', { turn, signal })
  signal.throwIfAborted()
}
if (turnEnds && this.inbox.nextStep.length === 0) break
```

一个 listener 想"反对停止"的唯一方式，是调用 `agent.steer(...)` 往 `next-step` inbox 塞一条消息。serial 跑完后，循环再读一次 `inbox.nextStep.length`——非 0 就继续下一个 step。这让"停止与否"由 inbox 数据驱动，**listener 注册顺序无法改变结果**。这条纪律是可组合性的关键：决策权从"谁注册得早"变成了"谁改了数据"。

## 第 3 章　一个 turn 的完整生命周期

`turn()` 方法（`agent.ts:246-330`）是核心。下面用伪代码画出它的状态机，标注哪些是**持久事件**（进 session log，可重放）、哪些是**实时事件**（agent 作用域通知，不进日志）、哪些是**waterfall/serial 扩展点**（可被监听拦截）。

```
turn()
 ├─ session.append('turn/start', {turn})                 ← 持久
 ├─ while(true):
 │   ├─ preStep: inbox.claim(target, turn)               ← 纯删除 splice，emit 'agent/inbox/claimed'(实时)
 │   │   + systemPrompt.assemble(...) + dispatch.waterfall('agent/pre-step')  ← 扩展点
 │   ├─ reject → turnEnds={blocked}; return false        （不写 step/start）
 │   ├─ 空首批 → turnEnds={completed}; return false
 │   ├─ session.append('step/start')                     ← 持久
 │   ├─ for msg of decision.messages: session.append('user/message', msg)  ← 持久
 │   ├─ step():
 │   │   ├─ buildRequest: dispatch.waterfall('agent/request')               ← 扩展点
 │   │   ├─ llm.stream → for chunk: session.append('assistant/chunk')       ← 持久（流式）
 │   │   ├─ session.append('assistant/message',…)                            ← 持久
 │   │   └─ toolCalls? → executeToolCalls:
 │   │         session.append('tool/call') + session.append('tool/result')   ← 持久
 │   ├─ finally: session.append('step/end')              ← 持久
 │   ├─ if turnEnds && nextStep 空: dispatch.serial('agent/turn-stopping')  ← 扩展点
 │   └─ target = 'next-step'
 └─ finally: session.append('turn/end', {turn, reason: turnEnds})  ← 持久（必有）
```

几个要点：

- **waterfall 必须调 `next()`**（见[第二篇·第 5 章](part-02-cordis.md)）。Cordis waterfall 是洋葱模型，最后一个 listener 收到的 `next` 是机器注入的默认实现（`agent/pre-step` 默认返回 `{kind:'enter', messages}`）。不调 `next()` 就没有默认决策——对 `agent/pre-step` 意味着直接挂起。唯一例外是 `agent/request-error`：它允许"不调 `next()` 而返回 `{kind:'retry'}`"来接管恢复。
- **turn 边界是可观测契约**。`turn/start` 一旦 append，`finally` 就必 append `turn/end`——即使首批被清空（消息被 cancel 清掉、或 pre-step 把 enter 改写成空），仍写一个 `{kind:'completed'}` 的平衡 turn。goal-round-driver 的 pause/disarm 就依赖这个 idle→running→idle 的翻转。
- **模型请求的 messages 由 `session.deriveMessages()` 派生**（见[第四篇](part-04-session.md)），不由循环自己维护。一个运行时不变量断言：任何时刻 `llm/stream` 的 `messages` 必须等于 `session.deriveMessages()`。

## 第 4 章　Agent 接口与所有权

### 4.1　Agent handle

```ts
// packages/core/agent/src/runtime-types.ts:63-104（节选）
export interface Agent {
  readonly id: SessionId            // 与 session.id 共享同一身份
  readonly options: AgentOptions    // provider/model/maxTokens
  readonly session: Session         // 持久日志是唯一真相源
  readonly inbox: Inbox             // agent 自己拥有的待办投影
  readonly status: AgentStatus      // 'idle' | 'running'
  readonly ctx: Context             // agent 作用域；贡献 agent-local，dispose 时 unwind
  cancel(cause: AgentCancelCause, options?: CancelOptions): void
  whenIdle(): Promise<void>
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
  followup(message): void   // send(msg, 'next-turn', true)
  steer(message): void      // send(msg, 'next-step', true)
  inject(message): void     // send(msg, 'next-step', false)
}
```

`status` 只有两个值 `idle|running`。**disposal 不是第三个 status**——消费侧观察不到 disposed 状态，只能观察 agent 离开注册表。`running` 描述的是驱动器整体的 drain 区间，可能横跨多个连续排队的 turn；它不证明当前有一个 turn 正开着。

### 4.2　dispose 是一种能力（CAPABILITY）

```ts
// packages/core/agent/src/index.ts:172-175
export interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
}
```

持有裸 `Agent` 的注册表观察者**不能**拆掉它。只有创建它的 owner 持有 handle。结构性上有两个 co-owner：caller fiber（owner 卸载则结构化回收）+ 注册的 factory provider（provider 卸载必须停掉它造的实例）。三者走**同一个 memoized teardown**。

### 4.3　工厂注册：让 consumer 不依赖具体 loop

```ts
// packages/core/agent/src/index.ts:372-388
setFactory(factory: AgentFactory): () => void {
  const dispose = this.ctx.effect(() => {
    if (this.factory !== undefined) throw new Error('an agent factory is already registered')
    this.factory = { target: factory }   // 包成 {target} 防 Cordis 错误追踪 factory 的依赖上下文
    return () => { this.factory = undefined }
  }, 'agents.setFactory()')
  return dispose
}
```

循环在构造时 `ctx.agents.setFactory(this)`。注册 effect 的 disposer 被**原样返回**（不包 wrapper），这样循环的构造器 effect 可以直接 `yield` 它，Cordis 会按 identity 在 owner 卸载时按 LIFO 嵌套卸载——这是 teardown 顺序正确性的载体（见第 6 章）。

## 第 5 章　inbox：两个 list 与取消收敛的唤醒锁存

inbox 是 agent 自己拥有的待办投影——两个有序的待发消息列表：

- **`next-turn`**：每个 turn 至多领取 1 条（对应"一条用户输入 = 一个 turn"）。
- **`next-step`**：每个 step 领取**全部**（steer、inject、工具续作的 additionalContexts 都进这里）。

`claim` 是**纯删除 splice**：

```ts
// packages/core/agent/src/inbox.ts:71-78
claim(target: InboxTarget, turn: number): UserMessage[] {
  const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)  // discardRemoved=false
  if (target === 'next-turn') {
    claimed.push(...this.mutate('next-turn', 0, 1, [], false))
  }
  for (const message of claimed) this.notifications.claimed(message, turn)
  return claimed
}
```

第四个参数 `discardRemoved=false`：claim **不** emit `agent/inbox/discarded`、**不**记 `outcome:'canceled'`，只写一条 `agent/inbox/spliced` 的纯删除。`agent/inbox/claimed` 是机器自己 emit 的实时事件——因为持久 splice 不带"被 claim"语义。两套消费者各取所需：观察单条消息的用 `inserted`/`claimed`/`discarded`；重建整队列投影（如 UI reconnect）的用持久的 `agent/inbox/spliced` 流。

### 5.1　cancel 的 first-cause-wins 与唤醒锁存

`AbortController.abort(cause)` 只接受第一次的 cause。`keepInbox:true` 不清队列、不写 canceled splice、不清锁存，只 abort 当前 turn；`keepInbox:false` 清 inbox 并清锁存。

这里有个最容易讲错的机制——**cancel-convergence 唤醒锁存**。`cancel(keepInbox:true)` 立即返回，但驱动器是异步收敛的（stream teardown、工具取消、`turn/end` append 都在 `abort()` 返回之后才 unwind）。在这段收敛窗口里，一条唤醒型 `send` 落进 `next-turn`，而 `wakeDriver()` 看到还是 `running` 相位就直接 return——**唤醒就丢了**，消息停在那里直到下一次唤醒。

```ts
// packages/core/agent-loop/src/agent.ts:172-193（wakeDriver，节选）
private wakeDriver(wakeAfterAbort = false): void {
  if (this.phase.kind !== 'idle') {
    const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
    if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
      this.phase.wakeRequested = true   // 置锁存
    }
    return
  }
  // idle 相位：开一个新 driver
  ...
}
```

锁存的解法：相位非 idle 且 `wakeAfterAbort`（= send 时相位已 abort）或 maintenance 时，置 `wakeRequested=true`；正在退出的 driver 在 `kick` 的 finally 里重放：`if (wakeRequested && inbox.hasPending) this.wakeDriver()`。这保证 `turn/end N` 落地后才有重放 driver 开 `turn/start N+1`。

两个非显然的细节：`signal.aborted` 判别是承重的，且 `wakingAfterAbort` 在 inbox 插入**之前**捕获（防 reentrant cancel 重分类）；`disposed` cancel **永不锁存**——teardown 不应等一个完整的 model turn。

### 5.2　whenIdle 与 runMaintenance

`whenIdle()` 用 do/while 比对 `activityDone` 的 identity，防止漏掉被替换的 driver。`runMaintenance()` 跑"真 idle 相位"的一次非 turn 维护任务（如 compaction）——它和 turn 结构性互斥，status 保持 idle，期间的唤醒输入落 inbox 但不触发（被锁存），等 maintenance 的 finally 重放。

## 第 6 章　创建事务：折叠进单个 ctx.effect

这是整套系统最非显然的工程决策之一。agent 的创建分三步：**prepare**（造机器、建 scope、注册反向 teardown，但不进任何注册表）→ **enter**（插 store、建 detach 闭包，不 announce）→ **announce**（emit `agent/created`）。每两步之间 `assertLive()`——任一同步 listener 启动 teardown 都会被捕获。

```ts
// packages/core/agent-loop/src/index.ts:524-530
unfollowOwner = ownerCtx.effect(() => () => {
  if (disposing !== undefined) return
  abort.abort(new Error(`agent "${id}" setup aborted: owner disposed during setup`))
  return dispose(true)
}, `agentLoop.lifecycle(${id})`)
```

**为什么把 session + agent 的整个生命周期折叠进单个 caller-supplied effect？** 因为 Cordis 对**同一 effect 内的多个 disposer 按 LIFO 链串行执行**，对**不同 effect（sibling）的 disposer 用 `Promise.all` 并发执行**（见[第二篇·第 6 章](part-02-cordis.md)）。

如果把"停循环"和"摘 session"放进两个 sibling effect，owner 卸载时它们会 `Promise.all` 竞态——循环还在 flush 最后一个 `turn/end`，session 的 append hook 已被摘掉，**closing event 就丢了**。折叠进单个 effect → LIFO 保序：先 `machine.cancel({kind:'disposed'})` → `await machine.whenIdle()` → `scope.dispose()`，**再** `detachAgent` → `detachSession`。

memoized dispose 让所有竞争的 owner（caller signal / factory teardown / owner fiber unload）await **同一个** quiescence。

### 图 1　创建事务的 effect 嵌套（LIFO 保 closing event）

```
ownerCtx.effect('agentLoop.lifecycle(id)')   ← 单个复合 effect（LIFO 链）
 │
 ├─ prepare(): 建机器/scope/反向 dispose
 │     abortController fuse: caller signal ∪ factory teardown ∪ owner fiber unload
 │
 ├─ publish(source):
 │     sessions.enter(session)  ─┐
 │     agents.enter(agent, owner)├─ 三个 detach 闭包（不 announce），assertLive() 夹每步
 │     sessions.announce(session)│     （agent/created 同步失败 → 回滚）
 │     agents.announce(agent)   ─┘
 │     emit 'agent/session-start'
 │
 └─ teardown（owner unload / dispose() 触发，LIFO 顺序）:
        1. machine.cancel({kind:'disposed'})
        2. await machine.whenIdle()      ← 循环最后一个 turn/end 落地
        3. scope.dispose()
        4. detachAgent()                 ← agent 离注册表（emit agent/disposed）
        5. detachSession()               ← session 摘出 store（emit session/disposed）

   关键：若拆成两个 sibling effect，Cordis 用 Promise.all 并发，
        step 2-3（循环 flush turn/end）与 step 4-5（摘 session append hook）竞态，
        closing turn/end 丢失。单个 effect 的 LIFO 链保序。
```

## 第 7 章　发起者作用域（initiator scope）

`ctx.agents` 带一个进程局部的"发起者"概念：`currentInitiator()` 返回继承了当前异步驱动链的 Agent。当父 agent 创建子 agent 时，setup 报告因果 parent，而 `agentCtx.agent` 标识 child。这是 AsyncLocalStorage 传播，不是显式参数。

但有一条纪律贯穿：**ambient presence ≠ liveness ≠ authorization**（环境性的存在不是存活证明也不是授权）。发起者方法只提供同进程的因果归因——用于日志、tracing、host 归属。主体和 owner 始终是显式的，worker/process/persistence/wire 边界的身份也是显式的。

## 权衡总账

- **turn/step 双层结构**的代价是两套编号与平衡规则（见[第四篇·第 5 章](part-04-session.md)的不变量）。收益是把"可取消的活动区间"（turn）和"一次模型往返"（step）分开——取消粒度、结束语义、重试边界都有了清晰落点。
- **turn-stopping 由数据决定**牺牲了"listener 返回值直接控制"的直觉，换来可组合性——多个 listener 各自 steer，顺序不影响结果。
- **创建事务折叠进单 effect**是一个容易被忽略的纪律（很多读者会以为"反正都是 cleanup 顺序无所谓"），代价是代码里到处有"为什么要 yield detach 再 announce"的注释，收益是 closing event 永不丢——teardown 正确性的基石。
- **cancel-convergence 唤醒锁存**用 `signal.aborted` 在插入前捕获的细节，换来了"keepInbox 停靠契约"与"不丢失唤醒"两者兼得。代价是这个机制极反直觉，且 `disposed` 永不锁存是一条必须记住的特例。
- **max-tokens 是粘性的**：一旦某 step 撞 token 上限，后续 completed step 不能降级 turn 结果——max-tokens 表示"模型被截断"是 turn 级真相，不是 step 级状态。

（turn/step 持久事件的类型与派生规则见[第四篇](part-04-session.md)；工具调用如何经守卫管线执行见[第五篇](part-05-tools.md)；agent 发起的工具如何回 log 见[第五篇·第 1 章](part-05-tools.md)。）
