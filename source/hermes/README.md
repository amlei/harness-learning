# Hermes Agent · 源码剖析

> 作者 **Amlei**　·　更新 **2026-08-08**

Hermes Agent（[Nous Research](https://github.com/NousResearch/hermes-agent)）源码实现剖析：以第三人称客观视角，按「篇 / 章 / 节」覆盖设计思想、实现机制与实现原理。约 80 万行代码、十四篇、20+ 张图。

📖 **[在线阅读](https://amlei.github.io/harness-learning/)**（推荐，含 Mermaid 渲染与代码高亮）
或直接在 GitHub 浏览下列 Markdown：

| # | 文件 | 主题 |
|---|------|------|
| 00 | [part-00-preface.md](./part-00-preface.md) | 序言与总目录 |
| 01 | [part-01-overview.md](./part-01-overview.md) | 总览与设计哲学 |
| 02 | [part-02-core-loop.md](./part-02-core-loop.md) | 核心代理循环 |
| 03 | [part-03-tools.md](./part-03-tools.md) | 工具系统 |
| 04 | [part-04-state.md](./part-04-state.md) | 状态与会话持久化 |
| 05 | [part-05-skills.md](./part-05-skills.md) | 技能系统与 Curator |
| 06 | [part-06-terminal.md](./part-06-terminal.md) | 终端执行与多后端环境 |
| 07 | [part-07-mcp.md](./part-07-mcp.md) | MCP 集成 |
| 08 | [part-08-gateway.md](./part-08-gateway.md) | 消息网关与平台适配 |
| 09 | [part-09-cli-tui.md](./part-09-cli-tui.md) | CLI、TUI 与仪表盘 |
| 10 | [part-10-plugins.md](./part-10-plugins.md) | 插件体系与提供者 |
| 11 | [part-11-orchestration.md](./part-11-orchestration.md) | 委派、Cron 与 Kanban |
| 12 | [part-12-config-security.md](./part-12-config-security.md) | 配置、Profile 与安全 |
| 13 | [part-13-research-deploy.md](./part-13-research-deploy.md) | 研究、记忆与部署 |
| 14 | [part-14-feature-tools.md](./part-14-feature-tools.md) | 关键功能工具的实现 |
