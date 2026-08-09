# 第三篇　流处理机制

*作者：Amlei　·　更新时间：2026-08-09*

> 大模型的生成是增量式的——token 逐个吐出，首字延迟（TTFT）与总吞吐同等重要。若编排框架只能在"整段消息就绪"后才向下游传递，流式优势在第一个节点就被截断。Eino 把"流"在 `schema` 层就定义为基础数据类型，使流能在图编排的节点间端到端透传。README 所称的 "automatically handles streaming throughout orchestration: concatenating, boxing, merging, copying streams"，其实现落点正在本篇与[第六篇·第 3 章 节点间的流编排](part-06-state.md)。
>
> 本篇只讲**流原语本身**：一个流如何收发、复制、合并、塌缩、转换。至于这些流在图节点边界如何被装箱/拆箱、如何与四种执行范式桥接，见[第六篇](part-06-state.md)。

---

## 第 1 章　流为何是一等公民

Eino 的流模型有一个与众不同的取向：它没有引入某种重型 Reactive 扩展库（RxGo / reactor 风格），而是**直接复用 Go 原生 channel + 泛型**，在 `schema/stream.go` 里构造了一组最小而自洽的抽象。

更关键的是把"流处理"与"图编排"**正交解耦**：

- `schema` 只懂"一个流怎么收发 / 复制 / 合并 / 塌缩"；
- `compose` 才懂"节点之间如何装箱 / 拆箱 / 桥接范式"（见[第六篇](part-06-state.md)）。

这种分层让流原语可以被任何子系统复用，而不与图引擎耦合。本篇自底向上，先看这对最基础的读写双端。

---

## 第 2 章　核心抽象：StreamReader / StreamWriter

### 2.1　读写双端与 read-once 契约

流由一对接口表示（`schema/stream.go`）：

- `StreamWriter[T]`（`stream.go:115`）只暴露 `Send(chunk T, err error) (closed bool)`（`stream.go:126`）与 `Close()`（`stream.go:139`）。`Send` 的返回值 `closed` 表示**接收端已提前放弃**——这是取消/背压信号回传给生产者的通道。
- `StreamReader[T]`（`stream.go:168`）只暴露 `Recv() (T, error)`（`stream.go:195`）、`Close()`（`stream.go:229`）、`Copy(n int) []*StreamReader[T]`（`stream.go:261`）。

二者通过 `Pipe[T](cap int)`（`stream.go:99`）成对创建，内部共享同一个 `stream[T]`：

```go
// schema/stream.go:375
type stream[T any] struct {
    items  chan streamItem[T]   // 数据通道，带缓冲 cap
    closed chan struct{}        // 接收端关闭信号
    // …
}
// schema/stream.go:384
type streamItem[T any] struct { chunk T; err error }
```

文档（`schema/doc.go:53-56`）为 `StreamReader` 定下一条硬约束：**read-once**——只有一个 goroutine 应调用 `Recv`，且必须 `Close` 恰好一次。错误和 data 被绑在同一帧 `streamItem{chunk, err}`（`stream.go:384`）里传输，因此流是"带内传错"的，而非另开一条错误通道。

### 2.2　五种内部 reader：流的"多形态"

`StreamReader[T]` 内部用一个 `readerType` 枚举（`stream.go:355-363`）区分五种实现，`Recv`/`Close` 按类型 switch 分派（`stream.go:195-210`、`stream.go:229-244`）。这是 Eino 流模型最关键的设计——**同一个 `StreamReader[T]` 接口背后，可以是五种完全不同的物理实现**：

| readerType | 实现结构 | 出处 | 含义 |
|---|---|---|---|
| `readerTypeStream` | `stream[T]` | `stream.go:375` | 原生 channel 背书的"真流" |
| `readerTypeArray` | `arrayReader[T]` | `stream.go:465` | 由切片包装的"伪流"，零拷贝、无 goroutine |
| `readerTypeMultiStream` | `multiStreamReader[T]` | `stream.go:504` | 多路 fan-in 合并流 |
| `readerTypeWithConvert` | `streamReaderWithConvert[T]` | `stream.go:596` | 带逐元素转换/过滤的流 |
| `readerTypeChild` | `childStreamReader[T]` | `stream.go:883` | fan-out 复制的子流 |

这一设计的好处：流的"构造形态"被保留为运行时信息。例如 `MergeStreamReaders` 看到 `readerTypeArray` 就直接抽其底层数组、看到 `readerTypeMultiStream` 就展开其子流（`stream.go:924-939`），避免无谓地造一堆 channel 和 goroutine。`arrayReader` 由 `StreamReaderFromArray[T](arr)`（`stream.go:461`）创建，`recv` 只是按下标递增（`stream.go:470`）——这是"把单值当流"的最廉价形态，也是后续"伪流"（fake stream）的底座。

> **一处辨析（勘误）**：仓库里**不存在名为 `oneof` 的类型**。文件 `schema/stream_oneof_test.go` 实际测试的是 `WithOnEOF` 选项（`stream.go:664`）——即在流到达 EOF 时注入"一个值 / 一个错误 / 直接 EOF"三选一的行为。"单值 vs chunk 流"的多范式，在 Eino 中由两套机制承担：其一是本节的五种 `readerType` 多形态，其二是[第六篇](part-06-state.md)的四范式 + 伪流桥接。两者都不是 sum/oneof 类型，而是接口加类型枚举。

### 2.3　背压、取消与 panic 安全

流的并发语义全部建立在原生 channel 之上：

- **背压**靠 `Pipe[T](cap)`（`stream.go:99`）的缓冲——cap 满则 `Send` 阻塞，自然背压到生产者；cap 为 0 即 rendezvous（会合式）。
- **取消传播**：接收端 `Close()` → `closeRecv()` → `close(s.closed)`（`stream.go:432-441`）；发送端 `Send` 在 select 里同时监听 `s.closed`，被关闭立刻返回 `closed=true`（`stream.go:411-426`），生产者据此提前退出。
- **并发 close**：`closeRecv()` 直接 `close(s.closed)`，对自动关闭场景用 `atomic.CompareAndSwapUint32` 防重复 close（`stream.go:433-438`）；`SetAutomaticClose`（`stream.go:279-310`）借 `runtime.SetFinalizer` 做 GC 兜底回收。
- **panic 安全**：把 reader 拉平成"真流"的 `toStream`（`stream.go:747`），其 goroutine 用 `recover()` 捕获 panic，转成 `safe.NewPanicErr`（`internal/safe/panic.go:35`）作为错误帧发给下游（`stream.go:751-758`），避免一个节点的 panic 拖垮整条管道。

---

## 第 3 章　拼接（concat）：把流塌缩成单值

当上游是流、下游只接受单值时，需要把整条流"吃掉"拼成一个完整对象。典型场景：节点以 `Invoke` 模式运行却收到 `Stream` 输出，或 host 多代理需要从模型流中读出完整消息以判断是否发生了 tool call（`flow/agent/multiagent/host/callback.go:61-83`）。

拼接分两层。

### 3.1　编排层

`compose/stream_concat.go:50` 的 `concatStreamReader[T]`：

1. `defer sr.Close()`（`stream_concat.go:51`）保证回收；
2. 循环 `Recv`，遇 `io.EOF` 退出，**遇 `SourceEOF`（合并流的某一路结束）跳过**（`stream_concat.go:62-64`）；
3. 0 个元素 → `emptyStreamConcatErr`（`stream_concat.go:48`）；1 个元素原样返回；否则交给 `internal.ConcatItems`（`stream_concat.go:82`）。

### 3.2　底座层

`internal/concat.go` 的 `ConcatItems[T]`（`concat.go:91`）按 `reflect.Kind` 分派：

- Map kind → `concatMaps`（`concat.go:113`）：按 key 分组聚合，每个 key 的多个值再递归 concat（深合并）。
- 其它 → `ConcatSliceValue`（`concat.go:174`）：1 个元素直接返回；查 `concatFuncs` 注册表（`concat.go:29`），命中则调用；未命中则用"**至多一个非零元素**"规则（`concat.go:189-204`）——全零返回零值，恰一个非零返回它，多个非零报错 `"cannot concat multiple non-zero value"`。

`concatFuncs` 在进程初始化时由 `schema/message.go:40-46` 注册了消息相关类型（`ConcatMessages`、`ConcatMessageArray`、`ConcatAgenticMessages`、`ConcatToolResults`），数值/布尔等用 `useLast`（`concat.go:49`，取最后一个）。字符串走 `concatStrings`，用 `strings.Builder` 一次预分配拼接（`concat.go:53`）。用户可通过 `compose.RegisterStreamChunkConcatFunc[T]`（`stream_concat.go:44`）扩展自定义类型。

> **concat 与 merge 的语义边界**：`concat` 是"同字段累加"（如 string 拼接、message 多段内容合并），服务于流式分片的合拢；`merge`（见[第 5 章](part-03-streaming.md)）是"多节点输出按字段合并"，服务于图 fan-in，且对重复 key 报错而非累加。`concatMaps`（`concat.go:113`）对同一 key 的多个值做"递归 concat"，而 `mergeMap`（`internal/merge.go:62`）对重复 key 直接报错——二者用于不同图场景，不可混淆。

---

## 第 4 章　复制（copy）：fan-out 的共享惰性链表

流的 read-once 约束意味着要"广播"必须显式复制。入口 `StreamReader.Copy(n)`（`stream.go:261`）：

- `n < 2` 直接返回原 reader（`stream.go:262`）；
- `readerTypeArray` 走 `arrayReader.copy(n)`（`stream.go:268`、`stream.go:482`）——切片共享、各自独立下标，零成本；
- 其它走 `copyStreamReaders[T](sr, n)`（`stream.go:274`、`stream.go:792`）。

`copyStreamReaders` 的实现是整个流子系统里最精巧的一段。它构造一棵**惰性构建的共享链表**：

```go
// schema/stream.go:784
type cpStreamElement[T any] struct {
    once sync.Once                  // 保证元素只被填充一次
    next *cpStreamElement[T]        // 指向下一个（惰性创建）
    item streamItem[T]              // 实际数据
}
```

`parentStreamReader.peek(idx)`（`stream.go:837`）的核心逻辑：

1. 取该 child 当前的 `subStreamList[idx]` 指针；
2. `elem.once.Do(...)`（`stream.go:848`）——**只有最先到达的 child 真正调用 `p.sr.Recv()` 从源流拉一个元素**，填入 `elem.item`，并按需 `elem.next = &cpStreamElement{}` 挂上空尾节点（`stream.go:851-854`）；
3. 后续 child 读同一个 `elem` 时 `once` 已触发，直接读 `elem.item`，**不重复消费源流**；
4. 读完后 `subStreamList[idx] = elem.next` 推进各自游标（`stream.go:862`）。

效果：N 个 child 看到完全相同的元素序列，但源流只被消费一次。注释（`stream.go:835-836`）指出"同一 idx 并发不安全、不同 idx 安全"——每个 child 必须在各自单 goroutine 的 for 循环里读。`parentStreamReader.close(idx)`（`stream.go:868`）原子递增 `closedNum`（`stream.go:832`、`stream.go:875`），**当所有 child 都关闭时才关闭源流**（`stream.go:877-880`），避免泄漏。

实际应用见 `flow/agent/react/react.go:88` 与 `:117`：tools 节点把 tool 结果流 `output.Result.Copy(2)`——一份给 `streamSender`（送回 agent 上下文），一份继续往下游传。

下图给出 copy 的共享惰性链表：

```
  源流 sr.Recv()        cpStreamElement 链表 (stream.go:784)        两个 child
                          +--- once.Do ---+
   chunk "A"  ---------> | elem0: item="A"| <--- child0.peek  (触发 Recv, 填充)
                          | next: elem1   | <--- child1.peek  (once 已触发, 直读)
                          +---------------+
   chunk "B"  ---------> | elem1: item="B"| <--- child0.peek  (触发 Recv)
   (仅消费一次!)          | next: elem2   | <--- child1.peek  (滞后读到 B)
                          +---------------+
   EOF                   | elem2: err=EOF |   (next 不再创建)
                          +---------------+
  child0、child1 各自维护 subStreamList[idx] 游标，独立推进；
  源流只被消费一次；全部 child Close 后才 Close 源流。
```

图注：`sync.Once` 保证链表每个节点只由"最先到达的 child"从源流拉取一次，其它 child 直接读已填好的 `item`，从而零重复消费地实现 fan-out。

---

## 第 5 章　合并（merge）：多路 fan-in 与 select 优化

`MergeStreamReaders[T](srs)`（`stream.go:912`）把多个 reader 扇入一个：

- `len<1` 返回 nil，`len<2` 原样返回（`stream.go:913-919`）；
- 遍历所有 reader，按其 `typ` 归一化为底层 `*stream[T]`：array 抽数组、multiStream 展开、withConvert/child 通过 `toStream()`（`stream.go:747`，起一个 goroutine 把 reader 转成真流）拉平（`stream.go:924-939`）；
- 全是数组则合成一个 `arrayReader`（`stream.go:941-949`）；否则构造 `multiStreamReader`（`stream.go:956`）。

`multiStreamReader.recv`（`stream.go:538`）是 fan-in 的核心：维护 `nonClosed` 下标列表，循环 select 所有未关闭流的 `items` 通道，谁先来读谁，关闭的从列表删掉，全关闭返回 `io.EOF`。

### 5.1　select 的性能优化

select 的优化在 `schema/select.go`：

- `maxSelectNum = 5`（`select.go:19`）是阈值；
- `receiveN[T]`（`select.go:21`）对 `len(chosenList) ≤ 5` 用**手写展开的 select**（`select.go:22-72` 列出了 1~5 路 case），避免反射开销；
- 超过 5 路时 `multiStreamReader` 在构造期就建好 `reflect.SelectCase` 切片（`stream.go:514-524`），用 `reflect.Select`（`stream.go:543-549`），并把已关闭路的 `SelectCase.Chan` 置零（`stream.go:549`）避免重复唤醒。

### 5.2　命名合并：哪一路结束了

`MergeNamedStreamReaders`（`stream.go:990`）与 `InternalMergeNamedStreamReaders`（`stream.go:1010`，被 compose 的 `streamReaderPacker.mergeWithNames` 调用，见[第六篇](part-06-state.md)）是增强版：给每个源起名字，**某路 EOF 时先吐一个 `*SourceEOF{sourceName}` 错误**（`stream.go:566-569`、`stream.go:56-62`），再继续读其它路；调用方用 `GetSourceName(err)`（`stream.go:67`）识别是哪一路结束了。这解决了普通 merge 中某一路结束被"静默吞掉"的问题，便于"先排空 A 再处理 B"这类逻辑。

---

## 第 6 章　转换与过滤：StreamReaderWithConvert

`StreamReaderWithConvert[T,D]`（`stream.go:691`）是"流的 map + filter"：对每个元素调 `convert`。两个特殊语义值得记住：

- `ErrNoValue`（`stream.go:47`）：convert 返回它则**静默丢弃该元素、继续读下一个**（`stream.go:732-734`），实现过滤；
- `WithOnEOF(fn)`（`stream.go:664`）：在流结束时注入"一个值 / 一个错误 / 直接 EOF"（`stream.go:706-713`），且只触发一次（`srw.eofDone`，`stream.go:604`、`stream.go:707`）；
- `WithErrWrapper(fn)`（`stream.go:653`）：包装非 EOF 错误，若包装后返回 nil 则跳过该错误块继续读（`stream.go:715-722`）。

`recv` 实现见 `stream.go:699-736`。compose 的 `generic_helper.go:220`、`:226` 大量用它做运行时类型断言与字段裁剪（见[第六篇](part-06-state.md)）。

### 6.1　UnboundedChan 的真实角色（一处重要勘误）

本节澄清一个常见误解。直观上会以为 `internal/channel.go` 的 `UnboundedChan` 是"流的底层通道原语"，但代码事实并非如此：**核心流（`stream[T]`）用的是 Go 原生带缓冲 channel**（`stream.go:390` 的 `make(chan streamItem[T], cap)`），`UnboundedChan[T]`（`channel.go:22`）**并不承载这些流**。

`UnboundedChan` 是一个基于 `sync.Mutex + sync.Cond` 的无界缓冲通道（`channel.go:22-94`），`Send` 追加到切片并 `Signal`（`channel.go:37-47`），`Receive` 在缓冲空且未关闭时 `Wait`（`channel.go:67-83`）。它的实际用户是：

- 图调度器：`compose/graph_run.go:938`、`compose/graph_manager.go:275` 用 `UnboundedChan[*task]` 做任务就绪队列；
- react agent 的消息回调聚合：`flow/agent/react/option.go:241-242`、`:359`、`:373` 用它把回调里收到的（可能流式、可能非流式）消息汇聚成 `Iterator` 暴露给调用方；
- adk：`adk/utils.go:32` 等。

它存在的理由是**图的节点就绪事件数量预先未知、且不能阻塞生产者**——Go 原生 channel 缓冲有限，满则阻塞，而调度器不能因为消费者慢就阻塞回调路径。所以"自己造一个无界通道"是有意为之，但它服务于调度与回调聚合，而不是 token 流本身。更深的展开见[第十二篇](part-12-internal.md)。

### 6.2　flow/ 下的真实分工（勘误）

`flow/` 下有 `agent/`、`indexer/`、`retriever/` 三个子目录，但它们**并非都在做"流适配"**：

- **`flow/agent/`** 真正重度使用流。`react/react.go` 把模型流（`*StreamReader[*Message]`）作为一等对象贯穿图分支：`StreamToolCallChecker`（`react.go:179`）消费一份模型流副本来判断"这一轮是直接回答还是要调工具"（默认实现 `firstChunkStreamToolCallChecker` 只看第一个非空 chunk，`react.go:218-240`）；tool 结果流通过 `Copy(2)` 双发（`react.go:88,117`）；agent 的 `Stream` 方法直接透传底层 runnable 的流（`react.go:485-487`）。`react/option.go` 的 `cbHandler` 用 `UnboundedChan` 把回调里的消息流汇聚成可迭代器（`option.go:235-401`），并在需要时用 `schema.ConcatMessageStream`（`message.go:1841`）把流塌缩成单消息（`option.go:393`）。
- **`flow/retriever/`** 本质是"批量返回 docs"，**不是流式组件**。`retriever/utils/utils.go` 的 `ConcurrentRetrieveWithCallback`（`utils.go:44`）是并发批量检索加回调埋点，用 `sync.WaitGroup` 等所有 `Retrieve` 完成（`utils.go:45-71`），不涉及流。检索器/索引器的流式形态由 `compose` 在节点边界通过"伪流 / 拼接"自动桥接（见[第六篇](part-06-state.md)），而非在 flow 包内。
- **`flow/indexer/`** 同样是非流式的批量写入（`indexer/parent/parent.go:115` 的 `Store` 做文档切分加子 ID 生成）。

---

## 第 7 章　数据流：一个 chunk 的端到端旅程

以 `agent.Stream(ctx, msgs)` 为例，一个 `*Message` chunk 从模型吐出到调用方收到：

```
   调用方                    compose 图                  model.Stream
     |                           |                           |
     | -- Stream(msgs) --------> |                           |
     |                           | -- Stream(msgs)---------> |
     |                           |                           | (逐 token 生成)
     |                           | <--- *StreamReader[M]---- | sw.Send(deltaMsg,nil)
     |                           |                           |
     |                           | 图引擎把 reader 在节点边界 |
     |                           | 装箱/拆箱/按范式桥接       |
     |                           | 经 branch 判定(可能 Copy) |
     |                           |                           |
     | <--- *StreamReader[M] --- |                           |
     | for { Recv() }            |                           |
     | chunk1, chunk2, ..., EOF  |                           |
     | Close()                   |                           |
```

三个关键点：

1. 模型一旦产出第一个 chunk，整条管道就已经在传，无需等全部生成。
2. 途中若经过只接受单值的节点，会触发 `concatStreamReader`（`stream_concat.go:50`）把流吃成单值再继续——此时该节点成为流式管道的"瓶颈点"。compose 用"伪流"在其下游恢复流形态，但 TTFT（首字延迟）已丢失（`schema/doc.go:70-75`）。
3. branch 节点（如 react 判断是否调工具）会消费一份流副本（`Copy`），不影响主路径继续流动。

节点边界处的装箱/拆箱与四范式桥接的具体机制，见[第六篇·第 3 章](part-06-state.md)。

---

## 第 8 章　为何如此设计：权衡的总账

1. **为何不用现成 channel，要再造一套 `StreamReader/Writer`**：原生 channel 缺三样东西——(a) 明确的"单生产者 / 单消费者 + EOF"契约；(b) 取消回传（接收端 `Close` 时 `Send` 能立刻知道）；(c) 类型安全的 fan-out（`Copy`）与 fan-in（`Merge`）。Eino 用 `streamItem{chunk,err}` 把错误和 data 绑在同一帧（`stream.go:384`），用 `closed chan struct{}` 做取消握手，用五种 `readerType` 把"流的来源形态"保留为运行时可优化的信息（见[第 2 章](part-03-streaming.md)）。
2. **Go 泛型与类型擦除的兼容**：`StreamReader[T]` 在 `schema` 层全泛型；`compose` 层用类型擦除的 `streamReader` 接口与 `streamReaderPacker[T]` 在节点边界做装箱/拆箱（见[第六篇](part-06-state.md)）。`internal/generic/generic.go:56` 的 `TypeOf[T]()` 用 `reflect.TypeOf((*T)(nil)).Elem()` 取类型做注册表 key——内部反射、边界泛型，是 Eino 一以贯之的取舍。
3. **保留"构造形态"为运行时信息**：五种 `readerType` 不是为了花哨，而是让 `Merge`/`Copy` 等操作能"看穿"流的来源、避免无谓地起 channel 和 goroutine。`arrayReader` 的零拷贝、`multiStreamReader` 的展开，都是这一设计带来的常数级优化。
4. **select 的 5 路阈值**：手写展开 select（`select.go:22-72`）规避反射开销，仅在超过 5 路时退回 `reflect.Select`。这是"快路径手工优化、慢路径通用兜底"的典型工程取舍。
5. **concat 与 merge 严格区分**：前者是"流式分片合拢"（同 key 累加），后者是"无重叠字段的 fan-in"（同 key 报错）。混淆二者会导致图数据流的语义错误，故在底座层（`internal/concat.go` vs `internal/merge.go`）就分头实现。
6. **`UnboundedChan` 不碰 token 流**：无界通道服务于"数量未知、不可阻塞生产者"的调度/回调场景，而非流原语。把它误读为"流的底层通道"会错判 Eino 的流模型——流始终坚持用有界 channel + 背压，避免无界内存增长。

---

*第三篇完。下一篇进入组件抽象体系，剖析 ChatModel、Tool、Retriever、Embedding、ChatTemplate 的接口契约——它们各自声明自己支持哪几种流范式，而框架负责把不匹配的范式在节点边界桥接起来（机制回到本篇与[第六篇](part-06-state.md)）。*
