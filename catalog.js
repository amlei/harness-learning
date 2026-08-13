/*
 * Harness Learning — root directory data
 * ─────────────────────────────────────────
 * Used ONLY by the root index.html (the directory / front door).
 * Each project owns its OWN reader page (source/<project>/index.html) with its
 * OWN inline manifest + theme — so projects are fully isolated from each other.
 *
 * THEMES here carries only the preview fields the directory cards need.
 * Page-level theming lives in reader/reader.css as :root[data-theme="…"].
 *
 * Add a project: drop source/<id>/index.html, then add an entry here.
 * Add a paper:   drop paper/<id>/index.html (+ .md), then add an entry here.
 */
window.CATALOG = {

  THEMES: {
    atelier:    { accent:'#8a2e2e', mark:'❦', display:'EB Garamond',         character:'parchment · oxblood · blog serif' },
    hermes:     { accent:'#d4a45a', mark:'☤', display:'Fraunces',          character:'antique gold · editorial serif' },
    periodical: { accent:'#8290b8', mark:'§',  display:'Spectral',         character:'slate indigo · periodical serif' },
    technical:  { accent:'#c7b08a', mark:'⌘', display:'Bricolage Grotesque', character:'graphite · utilitarian grotesque' },
    eino:       { accent:'#086480', mark:'⬡', display:'Open Sans',           character:'deep teal · technical doc sans' },
    dsh:        { accent:'#4176e6', mark:'◆', display:'DM Sans',              character:'brand blue · slate ink · clean grotesque' },
  },

  source: [
    {
      id:'hermes', title:'Hermes Agent', theme:'hermes',
      tagline:'A self-improving AI agent — dissected.',
      blurb:'约 80 万行的自我改进型 AI 代理框架。不讲"怎么用"，而是追问"它是如何被造出来的"——同步循环与异步桥、自注册工具系统、SQLite+FTS5 会话库、过程记忆技能与 Curator、七大终端后端、双向 MCP、二十余平台消息网关。',
      author:'Amlei', updated:'2026-08-08',
      statsLabel:'15 篇 · ~330KB · 25+ 图',
    },
    /* ─ add the next project here (and create source/<id>/index.html) ─ */
    {
      id:'eino', title:'Eino', theme:'eino',
      tagline:'A Go LLM framework — dissected.',
      blurb:'CloudWeGo/字节跳动的 Go LLM 应用开发框架。不讲"怎么用"，而是追问"它是如何被造出来的"——强类型流编排、Go 泛型驱动的图引擎与 Pregel 状态图、组件-编排-ADK 三层架构、ReAct 回合循环、人机协同中断与检查点、多代理委派。',
      author:'Amlei', updated:'2026-08-09',
      statsLabel:'13 篇 · ~200KB · 25+ 图',
    },
    {
      id:'dsh', title:'DeepSeek Harness', theme:'dsh',
      tagline:'A plugin-based agent harness — dissected.',
      blurb:'DeepSeek AI 开源的插件式 agent harness（dsh），跑在 vendored Cordis 上。不讲"怎么用"，而是追问"它是如何被造出来的"——万物皆插件的可逆副作用、turn/step 双层循环、事件溯源会话与 surface 投影、monotonic 守卫工具管线、可换后端的持久化与 crash 恢复、surface replace 上下文压缩、六种子 Agent 委派 provider、landlock 沙箱与 fail-closed 审批、profile/bundle 组合启动。',
      author:'Amlei', updated:'2026-08-13',
      statsLabel:'16 篇 · ~270KB · 35+ 图',
    },
  ],

  paper: [
    /* ─ add a paper here (and create paper/<id>/index.html) ─ */
  ],
};
