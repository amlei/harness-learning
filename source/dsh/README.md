# DeepSeek Harness — 源码剖析

本卷是 DeepSeek Harness（`dsh`）的第三人称源码实现剖析：设计思想、实现机制、实现原理。

- **上游仓库**：https://github.com/deepseek-ai/deepseek-harness
- **主题**：`dsh`（品牌蓝 #4176e6 + 暖白画布 + DM Sans，实测自 deepseek.com computed style）
- **阅读**：在线 https://amlei.github.io/harness-learning/source/dsh/ （本地 `python3 -m http.server 8000` 后访问 http://localhost:8000/source/dsh/）

## 目录

| part | 文件 | 主题 |
|---|---|---|
| 00 | `part-00-preface.md` | 序言与总目录（受众、概念入门、贯穿主线） |
| 01 | `part-01-overview.md` | 全景与设计哲学（八条核心决策、代码地图） |
| 02 | `part-02-cordis.md` | Cordis 插件框架（四种事件模式、可逆副作用） |
| 03 | `part-03-agent-loop.md` | Agent 循环（turn/step、inbox、创建事务） |
| 04 | `part-04-session.md` | 会话日志（事件溯源、surface 投影、派生） |
| 05 | `part-05-tools.md` | 工具系统（六阶段守卫管线、Code Mode） |
| 06 | `part-06-system-prompt.md` | 系统提示词装配（每步重读、scoped shadow） |
| 07 | `part-07-seams-scope.md` | 能力接缝与作用域（三角色、scope 两方向） |
| 08 | `part-08-persistence.md` | 会话持久化（flush batching、crash 恢复） |
| 09 | `part-09-compaction.md` | 上下文压缩（锁 bracket、surface replace） |
| 10 | `part-10-subagent.md` | 子 Agent 委派（六 provider、composeFrom bind） |
| 11 | `part-11-llm.md` | LLM 适配接缝（vocabulary、adapter、BlockAssembler） |
| 12 | `part-12-security.md` | 沙箱与审批（landlock、fail-closed） |
| 13 | `part-13-boot.md` | 组合与启动（profile/bundle/patch、preset） |
| 14 | `part-14-ecosystem.md` | 扩展生态（上）：Typert/workflow/projection/attachment/storage |
| 15 | `part-15-ecosystem.md` | 扩展生态（下）：hooks/skill/jobs/goal/spill/session-query/plan/todo |

## 一句话主线

**Everything is a plugin.**（万物皆插件）——没有特权内核；连循环、工具注册表、会话日志、模型适配器都是可替换的插件。每一项贡献都通过 `ctx.effect()`/`ctx.on()` 注册，卸载时 unwind。
