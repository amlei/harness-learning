# Eino · 源码剖析

把 CloudWeGo/字节跳动的 Go LLM 应用开发框架 **Eino** 读穿，写成一本面向学习者的"书式实现剖析"。不讲"怎么用"，而是追问"它是如何被造出来的"。

- 上游仓库：https://github.com/cloudwego/eino
- 上游官网：https://www.cloudwego.io/docs/eino/
- 作者：Amlei　·　更新：2026-08-09

## 主题

深青蓝（teal `#086480`）+ 白 + Open Sans，取自 cloudwego.io 官网实测的 computed style（hero banner `td-box--secondary #086480`、dark `#024053`、链接 azure `#3996ec`）。技术文档站式，非臆测。

## 目录

| 篇 | 文件 | 主题 |
|----|------|------|
| 00 | `part-00-preface.md` | 序言与总目录（阅读地图、写作立场、概念入门、章节关系图、贯穿主线） |
| 01 | `part-01-overview.md` | 总览与设计哲学（定位、Go 范式取舍、三大支柱、代码地图） |
| 02 | `part-02-schema.md` | 类型系统与消息模型（Message/Tool/Document、序列化、多 provider 适配） |
| 03 | `part-03-streaming.md` | 流处理机制（StreamReader/Writer、打包解包、concat/merge/copy） |
| 04 | `part-04-components.md` | 组件抽象体系（ChatModel/Tool/Retriever/Embedding/ChatTemplate） |
| 05 | `part-05-compose.md` | compose 编排引擎（Graph/Chain/DAG/Branch/Pregel/Runnable） |
| 06 | `part-06-state.md` | 图的状态、字段映射与流编排（StateGraph、field mapping、stream wiring） |
| 07 | `part-07-tools-interrupt.md` | 工具节点与中断/恢复/检查点（ToolsNode、HITL、checkpoint） |
| 08 | `part-08-callbacks.md` | callbacks 切面机制（五注入点、handler 链、流式观测） |
| 09 | `part-09-adk.md` | ADK 代理运行时（Agent/Runner/事件流、ReAct 回合循环） |
| 10 | `part-10-middlewares.md` | 中间件链（八种可插拔中间件） |
| 11 | `part-11-multiagent.md` | 多代理预置模式（DeepAgent/Plan-Execute/Supervisor） |
| 12 | `part-12-internal.md` | 内部通用机制与 Go 泛型（generic/gmap/gslice、channel/concat/merge） |

## 阅读方式

本地预览：在仓库根目录 `python3 -m http.server 8000`，开 `http://localhost:8000/source/eino/`。
