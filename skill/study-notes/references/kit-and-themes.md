# 阅读站点套件与主题格式

阅读站点的**套件已存在且通用**（`reader/reader.css` + `reader/reader.js`），新增一卷不改套件、只加文件 + 登记目录。本文件是它的结构、格式与主题定义规范。

## 目录结构

```
harness-learning/
├── index.html                 # 根目录页（house 主题）—— 目录，只导航
├── catalog.js                 # 内容登记（项目 + 文章元数据）
├── reader/
│   ├── reader.css             # 共享设计系统（主题 = :root[data-theme] 纯 CSS）
│   └── reader.js              # 共享阅读器引擎（路由/渲染/scroll-spy/复制/灯箱）
├── source/<slug>/
│   ├── index.html             # 本卷独立阅读器（自带主题 + 目录清单）
│   └── part-NN-<kebab>.md     # 各篇正文
├── paper/<slug>/              # 单篇文章（可选）
│   ├── index.html
│   └── <slug>.md
└── assets/                    # 主题核验截图等参考
```

## 新增一卷（source）的三个文件动作

1. **写正文**：`source/<slug>/part-00-…md` … `part-NN-…md`（`00` = 全文概览）。
2. **建阅读器**：复制任一已有卷的 `source/<slug>/index.html` → 新卷目录，改三处：
   - `<html data-theme="<slug>">`（主题 id，须先在 `reader/reader.css` 定义）
   - 品牌行印记 / `<title>` / favicon 色
   - 内嵌 `<script>window.READER = { kind:'source', home:{…}, parts:[…] }</script>`（见下）
3. **登记目录**：`catalog.js` 的 `source` 数组追加一条（见下）。

### `window.READER` 清单格式（阅读器引擎读它）

```js
window.READER = {
  kind: 'source',                 // 或 'paper'
  home: {
    title: '项目名', mark: '☤',    // 印记
    blurb: '一行简介。',
    author: 'Amlei', updated: '2026-08-09',
    repo: 'https://github.com/org/repo',   // 上游
    statsLabel: 'N 篇 · ~XXXKB · M 图',
  },
  parts: [
    // [file, 篇号, 标题, 一行主旨, 关键词[], 字数估]
    ['part-01-overview','01','总览与设计哲学','项目定位、核心设计决策、整体架构。',['架构','决策'], '~17k'],
    …
  ],
};
```
- `file` 不含扩展名（阅读器 `fetch('./'+file+'.md')`）。
- paper 形态：`kind:'paper'`，加 `paper:{file:'<slug>'}`，`parts` 省略。

### `catalog.js` 条目格式（根目录页读它）

```js
window.CATALOG = {
  THEMES: { /* 见下，主题预览字段 */ },
  source: [
    { id:'<slug>', title:'项目名', theme:'<slug>',
      tagline:'一句话', blurb:'简介',
      author:'Amlei', updated:'2026-08-09',
      statsLabel:'N 篇 · ~XXXKB · M 图' },
  ],
  paper: [ /* { id, title, theme, author, updated, blurb } */ ],
};
```

## 主题定义（`reader/reader.css`）

主题 = 一段 `:root[data-theme="<id>"]{ … }`，纯 CSS、无 JS、无 FOUC。每个主题可覆盖**画布**（ink/bone/rule）+ **主色**（accent）+ **字体** + 两个必填的派生变量：

```css
:root[data-theme="<slug>"]{
  /* 画布 */
  --ink:#……;  --ink-2:#……;  --ink-3:#……;  --ink-deep:#……;  /* 渐变/晕影端点 */
  --rule:#……;  --rule-soft:#……;
  --bone:#……;  --bone-dim:#……;  --mute:#……;  --mute-2:#……;
  --code-fg:#……;               /* 内联代码文字（浅底→深；深底→浅） */
  /* 主色 */
  --accent:#……;  --accent-soft:#……;  --accent-deep:#……;  --accent-2:#……;
  /* 字体（须已在该页 <link> 预加载） */
  --f-display:'…',serif;
  --f-body:'…',serif;
  --f-mono:'JetBrains Mono',ui-monospace,monospace;
}
```

> **`--ink-deep` 与 `--code-fg` 必填**：阅读器套件里书脊渐变端、顶栏背景、晕影用 `var(--ink-deep)`；内联代码文字用 `var(--code-fg)`。不填则浅色主题会暴露硬编码深色。代码块（`pre`）恒为深色岛、文字固定浅色，与主题无关。

`catalog.js` 的 `THEMES.<id>` 还需**预览字段**（供根目录卡片显示）：`{ accent, mark, display, character }`。

### 主题来源 = 上游仓库官网的真实风格（勿臆测）

1. 抓官网：无头浏览器（系统 Chrome + playwright-core）导航，等 JS 框架充分水合，读 **computed style**（`--ink`=body bg、`--bone`=正文色、主色取链接/按钮/品牌元素）——CSS 是 ground truth。
2. 视觉模型（GLM-5V-Turbo 等）识别截图交叉核验（视觉模型可能误判字体粗细等，以 CSS 为准）。
3. 据此填上面的变量。若官网是单色（如纯蓝+白），主题就守双色纪律，别加花哨强调色。
4. 截图存 `assets/<slug>-site-*.png` 留参考。

**范例**：Hermes 官网实测为饱和蓝 `#0000F2` + 白 `#FFFFFF` + 极细衬线大标题 + 白线蓝图插画——主题即据此定义，而非臆测的"金色"或"单色"。

## 阅读器套件内置能力（勿重复实现）

`reader/reader.js` 已提供，新卷自动享有：
- **路由**：`#/<file>` 读篇；无 hash 显示封面（proj-head + 目录）。
- **文档站式三栏**：左轨篇导航（spine）+ 左锚定宽阅读列（正文 ~72ch，代码/表/Mermaid 突破列宽）+ 右轨"本章目录"。
- **scroll-spy**：右轨随滚动高亮当前节。
- **阅读进度**：顶栏细条。
- **代码复制**：每块悬停浮现复制按钮 + 语言标签。
- **Mermaid 灯箱**：点图全屏放大（滚轮缩放/拖动/ESC 关），克隆 SVG 带 `var(--ink-3)` 底卡。
- **跨篇链接**：正文 `a[href$=".md"]` 被拦截改写为同卷 hash 路由（在 GitHub 上仍是相对链接）。
- **移动端**：窄屏右轨收起、左轨变抽屉。

## 本地预览与发布

- **本地**：`cd harness-learning && python3 -m http.server 8000`，开 `http://localhost:8000/`（阅读器 `fetch` 需 http，不能直接双击 html）。
- **发布**：`git push origin main`，GitHub Pages（source = main / root）即更新。
- 路径全部**相对**（`./reader/…`、`../../reader/…`、`./part-XX.md`），适配 Pages base `/<repo>/`。
