# 第一篇　总览与设计哲学

*作者：Amlei　·　更新时间：2026-08-09*

> 本篇是全书的骨架篇。它不深入任何一行具体实现，而是建立全局观：Eino 是什么、为什么用 Go 写、它由哪几根支柱构成、代码如何分层、贯穿全书的设计 DNA 是什么。后续十一篇都是在这些支柱上"放大"。
>
> 如果只读一篇，读这一篇与[第〇篇](part-00-preface.md)。

---

## 第 1 章　Eino 是什么

Eino（读作 ['aino]）是 CloudWeGo（字节跳动开源的微服务框架家族）推出的 **LLM 应用开发框架**，用 Go 编写，`module` 为 `github.com/cloudwego/eino`（`go.mod:1`）。它自我定位借鉴了 LangChain、Google ADK 等开源框架，并"遵循 Golang 惯例"（`README.md:17`）。

Eino 提供三类能力（`README.md:19-23`）：

- **组件（Components）**：可复用的积木——`ChatModel`、`Tool`、`Retriever`、`ChatTemplate` 等，官方实现（OpenAI、Ollama、Claude、Ark…）放在独立的 `eino-ext` 仓库。
- **编排（Composition）**：把组件连成图（Graph）、链（Chain）、工作流（Workflow）。
- **代理开发套件（ADK）**：构建能自主调用工具、多代理协作、人机协同（HITL）中断/恢复的 AI 代理。

这三个能力对应 Eino 的三个核心子目录：`components/`、`compose/`、`adk/`。支撑它们的是公共类型层 `schema/`、流原语 `flow/`+`internal/`、切面 `callbacks/`。代码体量上，`adk/` 最大（约 122 个 Go 文件），`components/` 与 `compose/` 次之（分别约 70、56），`schema/` 与 `flow/` 较小但承重。

---

## 第 2 章　三大支柱与代码地图

### 2.1　三大支柱

Eino 的全部设计都围绕三个支柱展开，后续各篇按此组织：

**支柱一：组件抽象（[第四篇](part-04-components.md)）**。Eino 只定义组件接口、把实现放 eino-ext，靠 Go interface 的隐式实现解耦——core 永远不反向引用 ext。`ChatModel`/`Tool`/`Retriever`/`Embedder`/`ChatTemplate` 各是极简的方法集，数据类型下沉到 `schema`。

**支柱二：编排引擎（[第五篇](part-05-compose.md)与[第六篇](part-06-state.md)）**。`compose` 把组件按**确定性拓扑**粘合成 DAG/工作流，编译期做类型检查与环检测，运行期用 Pregel 超步或 DAG 流水调度。

**支柱三：代理运行时（[第九篇](part-09-adk.md)）**。`adk` 在 compose 之上长出**自主性**——把"下一步做什么"交给 LLM 自己决定，ReAct 循环本身就是一张 compose.Graph，全过程以 pull-based 事件流吐给调用方。

### 2.2　代码地图与依赖链

```
                      schema/  (公共类型: Message/Document/ToolInfo/StreamReader)
                        ▲  被所有人依赖, 不依赖任何人 (叶子包)
                        │
          ┌─────────────┼─────────────┐
          │             │             │
   components/      compose/        adk/
   (接口契约)       (编排引擎)      (代理运行时)
   model/tool/      Graph/Chain/    Runner/Agent/
   retriever/...    DAG/Pregel/     ReAct/事件流/
                    Runnable        中断/取消
          │             │             │
          │   ┌─────────┴───┐         │
          │   │             │         │
          └───┴── flow/  ◄── internal/ ───► callbacks/
                  │       (管道层:       (切面:
                  │        generic/      OnStart/OnEnd/
                  │        channel/      OnError 五注入点)
                  │        concat/merge/
                  │        serialization/safe/core)
                  │
                adk/middlewares/ + adk/prebuilt/ + adk/filesystem/
                (中间件链 + 多代理预置 + 文件能力)
```

依赖方向严格自上而下：`schema` 是叶子，`internal/` 是管道底座，`components`/`compose`/`adk` 是三大支柱，`flow`/`callbacks` 是横切复用层。没有任何反向或环形依赖——这是 Eino 架构的硬约束（`components/model/doc.go:28` 等逐字复述"实现在 eino-ext"）。

---

## 第 3 章　为什么是 Go：泛型与隐式接口

Eino 把 Go 1.18 的两个特性当作设计 DNA：**泛型**与**接口的隐式实现**。

**泛型**让编排框架能在编译期对类型做强约束——编排的本质是"把若干签名各异的组件按类型串联"，若退化为 `any`+反射，类型错误只能运行期暴露。Eino 通过泛型把大量类型检查前移到编译期：`Runnable[I,O]`、`StreamReader[T]`、`Graph[*In,*Out]` 都是泛型类型。代价是 Go 1.18 泛型不支持"方法的类型参数"，故 Eino 用一条"**编译期泛型、运行期类型擦除**"的边界折中——构造期单态化生成闭包、存入 `any` 字段，运行期调度器只持有 `any`（见[第十二篇·第 6 章](part-12-internal.md)）。`go.mod:3` 的 `go 1.18` 也连带决定了 `gslice`/`gmap` 必须自造（1.21 的 `slices`/`maps` 标准包不可用，见[第十二篇·第 1 章](part-12-internal.md)）。

**接口的隐式实现**（结构化类型）让"接口在本仓、实现在外"成为可能：eino-ext 的 `openai.ChatModel` 只要导入 `components/model` 与 `schema` 即可被 compose 透明消费，无需 `implements` 声明（见[第四篇·第 1 章](part-04-components.md)）。

---

## 第 4 章　四种流范式：贯穿全书的设计 DNA

Eino 最值得先建立的全局认知，是**四种流范式**（`schema/doc.go:58`）：

| 范式 | 输入 | 输出 | 典型组件 |
|------|------|------|----------|
| **Invoke** | 单值 | 单值 | Retriever、Embedder |
| **Stream** | 单值 | 流 | ChatModel（流式生成） |
| **Collect** | 流 | 单值 | 分支节点（读完首 chunk 再决策） |
| **Transform** | 流 | 流 | 流式加工 |

组件只需实现自己擅长的那一两种范式，框架在节点边界**自动桥接**不匹配的范式：上游出单值、下游要流 → 包成单 chunk 的"伪流"；上游出流、下游要单值 → `concatStreamReader` 把流塌缩成单值（见[第六篇·第 3 章](part-06-state.md)）。这就是 README 所称 "automatically handles streaming throughout orchestration" 的实现落点。

流的底层是 `schema/stream.go` 的 `StreamReader[T]`/`StreamWriter[T]`——一对由 `Pipe[T](cap)` 创建的读写双端，read-once、必须 Close，背后由五种 `readerType`（`stream`/`array`/`multiStream`/`withConvert`/`child`）物理实现（见[第三篇·第 2 章](part-03-streaming.md)）。流的三种核心操作是 **concat**（塌缩成单值，[第三篇·第 3 章](part-03-streaming.md)）、**copy**（fan-out 的共享惰性链表，[第三篇·第 4 章](part-03-streaming.md)）、**merge**（多路 fan-in，[第三篇·第 5 章](part-03-streaming.md)）。这套流模型是 Eino 区别于许多框架的招牌——它没有引入 RxGo/reactor 风格的重型库，而是直接复用 Go 原生 channel + 泛型。

> **一处澄清**：`internal/channel.go` 的 `UnboundedChan[T]` **不承载 token 流**——核心流用 Go 原生带缓冲 channel，`UnboundedChan` 服务于调度/回调聚合（图任务就绪队列、adk 事件迭代器）。混淆二者会错判 Eino 的流模型（见[第三篇·第 6 章](part-03-streaming.md)与[第十二篇·第 3 章](part-12-internal.md)）。

---

## 第 5 章　确定性 vs 自主：compose 与 adk 的对照

Eino 用两个子系统的分工来覆盖 LLM 应用的两类编排需求：

- **`compose`（[第五篇](part-05-compose.md)）= 确定性编排**。开发者预先画好图，边、分支、并行、循环在编译期固定，运行期严格遵循。不确定性只来自 `Branch` 的条件函数返回值与循环图的超步迭代次数。正因确定性，compose 才能做到编译期类型检查（[第五篇·第 3 章](part-05-compose.md)的 `updateToValidateMap` 不动点推断）、拓扑环检测、可恢复的检查点中断。
- **`adk`（[第九篇](part-09-adk.md)）= 自主决策**。把"下一步做什么"交给 LLM——模型读对话历史、决定是否调工具、调哪个、何时收尾。框架只在每个回合里执行这个决定。

二者的关系不是"替代"而是"复用"：**adk 的 ReAct 循环本身就是一张 compose.Graph**（`adk/react.go:354` 的 `newReact`，见[第九篇·第 4 章](part-09-adk.md)）——Init/ChatModel/CancelCheck/ToolNode 等节点加一条回边。因此 adk 天然复用 compose 的流式编排、状态注入（[第六篇](part-06-state.md)）、中断/checkpoint（[第七篇](part-07-tools-interrupt.md)）、回调切面（[第八篇](part-08-callbacks.md)）。

调度模型上，compose 有两种执行模式（[第五篇·第 4 章](part-05-compose.md)）：**Pregel**（默认，AnyPredecessor 触发 + barrier 超步，支持循环，靠 `maxRunSteps` 兜底）与 **DAG**（Workflow/AllPredecessor + 流水，禁止循环，靠 `validateDAG` 编译期拒绝）。

---

## 第 6 章　横切关注点：状态、中断、切面、中间件

围绕三大支柱，Eino 有四套横切机制，它们是让框架"可观测、可恢复、可扩展"的关键：

**状态（[第六篇·第 1 章](part-06-state.md)）**：图的累积状态是**挂在 `context.Context` 上的可变单例 + mutex + 用户处理器原地改写**，**不是** LangGraph 那种"每字段 reducer、每轮自动 reduce"的模型。所谓"每轮 reduce"真正发生在 `channel.get` 里多前驱 fan-in 的 `mergeValues`——reduce 的对象是节点输出而非状态本身。字段映射（[第六篇·第 2 章](part-06-state.md)）让节点 I/O 类型不必精确匹配。

**中断/恢复/检查点（[第七篇](part-07-tools-interrupt.md)）**：任意工具或节点能暂停执行、等待人工输入、从断点续跑。中断以 error 形式抛出（三档：`Interrupt`/`StatefulInterrupt`/`CompositeInterrupt`），冒泡到 Runnable 边界，由地址驱动的定向恢复续跑。检查点用自研类型标签 JSON 序列化整个图状态（含状态单例的深拷贝），支持版本迁移。

**callbacks 切面（[第八篇](part-08-callbacks.md)）**：OnStart/OnEnd/OnError 等五个注入点横切所有组件/图/agent，handler 链按"洋葱模型"调用（OnStart 逆序、OnEnd 正序）。流式观测要付出 N+1 倍 stream 复制的代价。组件通过 `Checker` 开关选择"自管回调"或"框架托管"。

**中间件链（[第十篇](part-10-middlewares.md)）**：adk 的横切能力（动态工具、摘要压缩、规范注入、文件访问等）抽成一条可插拔的 `handlers` 列表，分"每回合—每模型调用—每次工具调用"三个粒度，核心 ReAct 循环对具体能力零感知。

---

## 第 7 章　代码地图与阅读路线

```
理解类型与流：       ① → ② → ③                （schema · 流）
理解确定性编排：     ② → ④ → ⑤ → ⑥            （组件 · 图 · 状态）
理解自主 agent：     ⑤ → ⑨ → ⑩ → ⑪            （图 · ADK · 中间件 · 多代理）
理解可观测/可恢复：  ⑦ → ⑧                     （中断/检查点 · callbacks）
```

- **类型与流主线**：[第二篇](part-02-schema.md)（公共类型）→ [第三篇](part-03-streaming.md)（流原语）。
- **编排主线**：[第四篇](part-04-components.md)（组件契约）→ [第五篇](part-05-compose.md)（图/链引擎）→ [第六篇](part-06-state.md)（状态/字段映射/流编排）。
- **agent 主线**：[第九篇](part-09-adk.md)（ADK 运行时）→ [第十篇](part-10-middlewares.md)（中间件）→ [第十一篇](part-11-multiagent.md)（多代理预置）。
- **横切主线**：[第七篇](part-07-tools-interrupt.md)（中断/检查点）→ [第八篇](part-08-callbacks.md)（切面）。[第十二篇](part-12-internal.md)（internal 管道层）随时可读。

---

## 第 8 章　为何如此设计：权衡的总账

1. **接口在本仓、实现在外**：core 零外部 SDK 依赖、永远轻量稳定；provider 独立演进发布；避免环形依赖与"上帝包"。代价是用户要跨两个仓库（`eino` + `eino-ext`）拼装完整应用。
2. **泛型优先、反射兜底**：把类型错误前移到编译期，只在"类型擦除边界"（图编排动态分发、检查点序列化）回落到反射。代价是 Go 1.18 泛型能力受限（`implSpecificOptFn any` 配类型断言的迂回）。
3. **确定性编排（compose）与自主决策（adk）分治**：各擅其长——compose 可预测、可类型检查、可恢复；adk 灵活、可处理开放任务。adk 复用 compose 作执行引擎，二者非替代。
4. **流为一等公民**：把流在 `schema` 层就定义为基础数据类型，使流能端到端透传。代价是 `StreamReader` 的 read-once/必须 Close 是隐性契约负担（见[第三篇·第 2 章](part-03-streaming.md)）。
5. **状态用可变单例而非 reducer**：实现轻、对 Go 开发者心智直接、避免每轮深拷贝；代价是回放/分叉要靠 checkpoint 显式 `deepCopyState`。
6. **adk 用事件迭代器而非回调**：调用方控制节奏、天然支持背压与流式；代价是生产端需 goroutine + 无界 channel（见[第九篇·第 2 章](part-09-adk.md)）。
7. **多代理收敛到 agent-as-tool**：源码里一半的转移相关 API 挂着 `NOT RECOMMENDED`，官方路线从"全上下文转移/workflow"收敛到"agent-as-tool"（见[第九篇·第 9 章](part-09-adk.md)与[第十一篇](part-11-multiagent.md)）。
8. **自研类型标签 JSON 序列化**：换取 checkpoint 可读、可迁移、跨版本可控；代价是类型必须显式注册、性能不如二进制（见[第十二篇·第 4 章](part-12-internal.md)）。

---

*第一篇完。接下来从[第二篇](part-02-schema.md)开始逐子系统地深挖，或回到[第〇篇](part-00-preface.md)看概念入门与总目录。*
