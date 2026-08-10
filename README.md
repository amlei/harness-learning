# Harness Learning

> 一座私人源码工坊：按**每个开源仓库自身的风格**排印的源码实现剖析，外加文章整理。
> 不是使用手册——而是反过来追问"这套系统是如何被造出来的"。

📖 **[在线阅读](https://amlei.github.io/harness-learning/)**　·　启用 GitHub Pages（Settings → Pages → Branch: `main` / root）后即可访问。

---

## 架构：每卷一个独立页面

```
harness-learning/
├── index.html              # 主仓库首页 = 目录（本仓库自己的风格），只做导航
├── catalog.js              # 目录数据：项目 / 文章清单（仅元数据）
├── reader/
│   ├── reader.css          # 共享设计系统（主题用 :root[data-theme] 表达）
│   └── reader.js           # 共享阅读器引擎
├── source/
│   └── hermes/
│       ├── index.html      # ← Hermes 自己的阅读器（独立主题，互不影响）
│       └── part-*.md
├── paper/
│   └── _template.html      # 新增文章时复制此模板
├── skill/pro-to-book/      # pro-to-book 技能：把任意仓库（project）读穿成书的完整方法论（SKILL.md + references）
└── .claude/skills/pro-to-book → ../../skill/pro-to-book   # 软链，供 Claude Code 自动发现
```

> 🛠️ **完整方法论已固化为 [`skill/pro-to-book`](./skill/pro-to-book/SKILL.md) 技能**——用 `/pro-to-book` 给任意新仓库产出本书式的源码剖析（深挖→成篇→阅读站点，含主题核验、反知识诅咒、交叉引用等全部规则）。

**核心约定**：

- **主仓库 `index.html` 只作目录**，用本仓库自己的风格（verdigris patina）。它列出所有卷与文章，链接到各自的阅读器，本身不渲染任何正文。
- **每个 project 有自己独立的 `index.html`**（`source/<project>/index.html`）。它自带主题与目录清单，读取本目录下的 `part-*.md`，**不依赖其它 project，也不依赖主仓库的 `catalog.js`**。这样各卷互不影响，新增一卷也不会动到别的卷或主首页的渲染逻辑。
- 共享的只是**引擎与设计系统**（`reader/reader.css` + `reader/reader.js`）——这是基础设施，升级它等于升级"印刷机"，对所有卷一视同仁。

---

## 排印规则（house rule）

每个源码卷的视觉主题——字体、配色、印记——需**呼应其上游仓库本身的气质**，而非套统一文档皮肤。

主题在 `reader/reader.css` 里以 `:root[data-theme="…"]` 定义一次，由各卷在自己的 `<html data-theme="…">` 上引用。纯 CSS、无闪烁、无 JS 主题切换。

| 仓库气质 | 主题 id | 配色 / 字体 |
|----------|---------|-------------|
| 工坊／首页 | `atelier` | 铜绿 verdigris · Fraunces/Newsreader |
| 编辑／产品向（如 Hermes） | `hermes` | 古金 · Fraunces/Newsreader |
| 论文／文章 | `periodical` | 冷靛 · Spectral |
| 系统／内核／Go | `technical` | 石墨 · Bricolage Grotesque/IBM Plex Sans |

> 要引入新主题：在 `reader/reader.css` 加一个 `:root[data-theme="x"]{…}` 块，并在 `catalog.js` 的 `THEMES` 里加同名的预览字段（accent / mark / display / character），供目录卡片使用。

## 写作标准

- 第三人称客观视角，覆盖设计思想、实现机制、实现原理。
- 关键机制标注 `文件:行号`。
- 每个 `part-XX-*.md` 首行 `# 第N篇　标题`，次行 `*作者：Amlei　·　更新时间：YYYY-MM-DD*`。
- 与既有文档的出入显式标注为勘误。

---

## 如何新增内容

### 新增一卷源码

1. 建目录 `source/<project>/`，写入 `part-00-…md` … `part-NN-…md`。
2. 复制 `source/hermes/index.html` 为 `source/<project>/index.html`，改三处：
   - `<html data-theme="…">` 选一个呼应该仓库气质的主题；
   - `<title>` / favicon 色 / spine 里的品牌字与印记；
   - `<script>window.READER = { home:{…}, parts:[…] }</script>` 换成本卷元数据与目录。
3. 在 `catalog.js` 的 `source` 数组追加一条（供首页目录卡片显示）。
4. 完成。该卷与其它卷完全隔离。

### 新增一篇文章

1. 建 `paper/<slug>/`，写入 `<slug>.md`。
2. 复制 `paper/_template.html` 为 `paper/<slug>/index.html`，把 `window.READER` 的 `kind` 设为 `'paper'`、`paper.file` 指向 `<slug>`、填好 `home`。
3. 在 `catalog.js` 的 `paper` 数组追加一条。
4. 完成。

> 两种情况都**不需要改 `index.html`（主首页）或 `reader/*`**。

---

## 本地预览

阅读器用 `fetch` 加载 markdown，需 http（不能直接双击 html）：

```bash
cd harness-learning
python3 -m http.server 8000
# http://localhost:8000/            目录
# http://localhost:8000/source/hermes/   Hermes 阅读器
```

## 部署

提交到 `main`，GitHub Pages 设为 `main / root`，访问 `https://amlei.github.io/harness-learning/`。

---

个人学习用途，持续更新中。
