# 第六篇　系统提示词装配
*作者：Amlei　·　更新时间：2026-08-13*

每次模型请求，`dsh` 都要装配一份"系统提示词"——它由若干 **section**（提示词段）、若干 **context**（运行时上下文快照）、一组 **tool schema**、和若干 **variable**（变量）组成。这一篇讲 `ctx.systemPrompt` 如何把这些片段按作用域合并、按顺序排列、按瀑布变换，最终拼成 `EpochHeader.system`。

源码在 `packages/core/system-prompt/src/index.ts`（约 600 行）。它和 `dsh-scope`（见[第七篇](part-07-seams-scope.md)）紧密协作——section/context/variable 都可以按 agent 作用域分层，scoped 的覆盖 global。

## 第 1 章　为什么每步重读

一个反直觉的事实：系统提示词**不是在会话开始时构建一次**，而是每个步（step）都重新装配。原因在于 section/context/variable 的 `text` 可以是一个**求值函数** `(context) => string`，每次调用都可能变。

```ts
// packages/core/agent-loop/src/agent.ts:230（preStep 里调 assemble）
// packages/core/agent-loop/src/agent.ts:337（步内 renderPrompt(assembly)）
```

典型的动态来源：运行时上下文快照（当前沙箱 mode、当前审批 policy）、动态工具集、session 当前状态。缓存系统提示词就等于背叛这个动态性。代价是每步一次 `assemble`（O(sections+tools)，远小于一次模型调用）。

## 第 2 章　四种贡献与作用域合并

插件通过四个口子注册贡献，全部是作用域的、可 dispose 的、变更时 emit `system-prompt/change`：

- **`.section()`**：一段提示词。有 `name`、`order`（排序权重）、`text`（字符串或函数）、可选 `complete: true`（见第 4 章）。
- **`.context()`**：一条运行时上下文快照（会作为 user-role 消息追加，而非进 system 文本）。有 `order`。
- **`.tools()`**：一个工具 schema 提供者（返回 `{schemas, knownNames?}`）。
- **`.variable()`**：一个命名变量（供 section 文本插值或其它消费者用）。

作用域合并的规则（`assemble`，`index.ts:467-542`）：

```ts
// packages/core/system-prompt/src/index.ts:484（节选）
const sectionByName = this.layers.merge(scope, layer => layer.sections)  // scoped shadows global
const variables = {}
for (const [name, provider] of this.layers.global.variables.entries()) variables[name] = provider(context)
for (const layer of scopeLayers) for (const [name, provider] of layer.variables.entries()) variables[name] = provider(context)
// tool schema：global + 所有 scope provider 都贡献
const providers = [...this.layers.global.toolProviders.values(), ...scopeLayers.flatMap(l => [...l.toolProviders.values()])]
```

变量是 "global 先读，然后从最远到最近 scope 覆盖"（最近 scope 赢）；section 是 "scoped shadows global，同名 scoped 覆盖 global"；tool schema 是 "global + 所有 scope provider 都贡献"（不覆盖，而是合并）。这套合并语义靠 `dsh-scope` 的 `ScopedLayers` 实现（见[第七篇·第 3 章](part-07-seams-scope.md)）。

## 第 3 章　deployment:persona：约定的 persona 锚点

`PERSONA_SECTION = 'deployment:persona'`（order 0）是一个约定锚点。agent preset 用同名 scoped section **shadow** 全局默认 persona——这就是 "deployment:persona 可 shadow 全局默认"。

```ts
// packages/core/system-prompt/src/index.ts:128-131
const PERSONA_SECTION = 'deployment:persona'
```

子 agent 委派时，parent 的 persona 可被 child 的 scoped `deployment:persona` section 覆盖（见[第十篇·第 6 章](part-10-subagent.md)的 `applyChildComposition`）。这让"这个子 agent 用不同人格"成为一行配置。

## 第 4 章　complete section：插件接管整个 system prompt

`complete: true` 的 section 是"插件接管整个 system prompt"的口子。waterfall 跑完（让工具/变量解析），然后强制 sections 只剩这一个：

```ts
// packages/core/system-prompt/src/index.ts:509, 536-541（节选）
const completeSections = sectionDefinitions.filter(s => s.complete === true)
if (completeSections.length > 1) throw new Error('multiple complete prompt sections are active: ...')
// waterfall 后：
sections: completeSection === undefined ? transformed.sections : [completeSection]
```

多于一个 complete section 直接 throw——避免两个插件都试图接管整个 prompt 时的歧义。

## 第 5 章　tool schema 在这里装配，而非在 dsh-tools

工具 schema 是 `GenerateOptions`（模型请求）的一部分，所以它在 `system-prompt` 装配。`ctx.tools` 构造时注册一个 tool provider（见[第五篇·第 1 章](part-05-tools.md)），`systemPrompt` 调用它拿 `schemas`，再经 `orderTools` 应用 `toolOrder` 配置。

```ts
// packages/core/system-prompt/src/index.ts:164-178（orderTools，节选）
// 应用 toolOrder 配置 + <unlisted-tools> rest 标记
```

`orderTools` 让部署可以指定工具在 schema 列表里的顺序（某些模型对靠前的工具更敏感），未列出的工具落到 `<unlisted-tools>` 标记位置。

## 第 6 章　waterfall：system-prompt/assemble

装配完成后，`assembly` 经过一个 `system-prompt/assemble` waterfall，让 expert listener 可以 mutate 它（调整 section 顺序、注入额外 context、过滤工具）。这是"专家级"的整 prompt 改写口子，日常插件用 `.section()`/`.context()` 即可，不必挂 waterfall。

## 第 7 章　与 EpochHeader 的关系

装配出的 `system` 文本 + `tools` schema + call config，最终进入 `EpochHeader`（见[第四篇·第 6 章](part-04-session.md)）：

```ts
// packages/core/session/src/types.ts:201-210
export interface EpochHeader {
  config: LlmCallConfig                          // provider/model/reasoningEffort/temperature/maxTokens/stop
  adapterDefaults?: LlmCallConfigAdapterDefaults // adapter 物化的字段标记
  system?: string                                // 渲染后的 system 文本
  tools?: ToolSchema[]                           // 组装后的工具 schema
}
```

因为 system 文本是 `EpochHeader` 的一部分，且 `headerEquals` 去重（没变就不重 log），所以一个不变的 system prompt 不会让日志膨胀——只在它真的变了时才记一条 `request/header` 带 `reason: 'change'`。

## 第 8 章　runtime context snapshot：稳定的缓存前缀之后

`sandbox:policy`（order 110）和 `approval:policy`（order 115）这类 context 是**运行时上下文快照**——它们在每步装配时求值，反映当前沙箱 mode 和审批 policy。

> **为什么放在 context 而非硬编码进 prompt？** 一个历史教训：早期把沙箱 mode 硬编码进 prompt 导致"软锁定"——模型读到"当前 read-only"后，即使后来 mode 切换了，缓存的历史里仍是旧的，模型会拒绝尝试被拒绝的工作。把它放进运行时 context 快照（在稳定 prompt 缓存前缀之后附加），mode 切换不会破坏 prompt 缓存，模型每步看到的是当前真相。

## 权衡总账

- **每步重读**牺牲了一次性构建的效率，换来对动态 section/context/variable 的忠实。代价是每步一次 assemble，但远小于一次模型调用。
- **scoped shadows global**让 per-agent 定制（persona、工具集、prompt 段）成为可能，而无需改全局。代价是合并规则的复杂度（变量最近赢、section 覆盖、工具合并是三套不同规则）。
- **complete section**给"插件接管整个 prompt"留了口子，但用 "多于一个就 throw" 防止歧义。
- **tool schema 在 system-prompt 装配**而非在 dsh-tools，让"模型看到什么"统一在一个 resolver——与[第五篇·第 1 章](part-05-tools.md)的"模型能看到什么和能调什么是同一个 resolver 的两个投影"呼应。
- **runtime context 放在稳定缓存前缀之后**是一个从"软锁定"教训里学到的设计——把会变的真相与稳定的 persona/指令分开，保护 prompt 缓存。

（工具 schema 的白名单与执行见[第五篇](part-05-tools.md)；EpochHeader 的重建与去重见[第四篇·第 6 章](part-04-session.md)；adapterDefaults 如何被剥离见[第十一篇·第 3 章](part-11-llm.md)。）
