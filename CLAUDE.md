# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A static **publishing site** ("a source-code atelier"), not a buildable application. There is **no build step, no test suite, no linter, no package manager** — just static HTML/CSS/JS plus Markdown content, deployed to GitHub Pages from `main` / root. Do not look for or add a build pipeline; the pages ship as-is.

The purpose: deep, third-person source-code monographs of upstream open-source repos, each set in a visual theme that echoes that repo's own character. Content prose is Chinese; code, structure, and file names are English.

## The one architecture rule: per-volume isolation

Each volume (source repo study) is a **fully self-contained, independent page**. This is the invariant the whole repo is built around:

- A project reader (`source/<id>/index.html`) carries its own inline theme (`<html data-theme="…">`) and its own inline `window.READER` manifest, and `fetch`es only `./part-*.md` in its own directory. It does **not** depend on `catalog.js`, on the root `index.html`, or on any other volume.
- The only shared infra is the **reader kit** (`reader/reader.css` + `reader/reader.js`). Treat these like a printing press: editing them affects every volume equally. Be deliberate and conservative when touching them.
- The root `index.html` is a **directory only** — it renders no prose, just lists volumes/papers from `catalog.js`. It has its own house theme (`atelier`).

Net effect: adding one volume can never break another volume or the directory.

## The reader engine contract (`window.READER`)

Every reader page (project or paper) sets a global before loading `reader/reader.js`. The engine reads nothing else.

```js
window.READER = {
  kind: 'source' | 'paper',
  home: { title, mark, blurb, author, updated, repo, statsLabel },
  parts: [ /* only when kind==='source'; one row per part */
    [file, num, title, essence, keywords[], size],   // e.g. ['part-02-core-loop','02','核心代理循环','…',['压缩','中断'],'~19k']
  ],
  paper: { file }  // only when kind==='paper'; the .md basename next to the page
};
```

Routing is hash-based and lives in `reader/reader.js`: for `source`, no hash → cover (built from `home` + `parts`); `#part-NN-…` → `fetch('./part-NN-….md')`, strip the byline/`#` title, render with marked → DOMPurify → highlight.js, build a right-rail outline with scroll-spy, and run Mermaid. For `paper`, it loads the single `paper.file` doc. Markdown is fetched over HTTP, which is why local preview needs a server (see Commands).

The full engine is ~200 lines in `reader/reader.js` — read it before changing rendering behavior.

## Theming

Pure CSS, no JS theme switching, no FOUC. Each theme is defined once in `reader/reader.css` as `:root[data-theme="…"]` and chosen per page via `<html data-theme="…">`. Existing themes: `atelier` (directory/house), `hermes`, `periodical` (papers), `technical` (systems/Go repos).

- To **add a theme**: add a `:root[data-theme="x"]{…}` block to `reader/reader.css` **and** add matching preview fields (`accent` / `mark` / `display` / `character`) under `THEMES` in `catalog.js` (the directory cards read those).
- A theme's real colors must be **measured from the upstream repo's own site** (computed styles via headless browser, cross-checked with a vision model), not guessed. See the Gotchas in `skill/pro-to-book/SKILL.md` — this repo once shipped a wrong theme from a misread Next.js site.
- Mermaid palette is read from CSS vars at runtime and picks light/dark by canvas luminance; don't hardcode darks — light themes will expose them.

## Commands

```bash
# Local preview — REQUIRED, not optional: pages use fetch() so file:// breaks.
python3 -m http.server 8000
#   http://localhost:8000/                    directory
#   http://localhost:8000/source/hermes/      a volume
#   http://localhost:8000/source/hermes/#part-02-core-loop

# Deploy — push to main; GitHub Pages is configured for main / root.
git push origin main
```

There is no test command. To validate a change, open the relevant page in the local server and click through: cover → a part → a cross-reference link → a Mermaid diagram (click to zoom).

## Adding a new volume (the 3-step copy procedure)

1. Write `source/<id>/part-00-…md` … `part-NN-…md`.
2. Copy `source/hermes/index.html` → `source/<id>/index.html`, change **only three things**:
   - `<html data-theme="…">` (pick one that fits the upstream repo's character),
   - `<title>` / favicon color / spine brand line + mark,
   - the inline `window.READER` (`home` metadata + `parts` rows).
3. Append one entry to the `source` array in `catalog.js`.

Adding a paper is analogous: copy `paper/_template.html` → `paper/<slug>/index.html`, set `kind:'paper'` + `paper.file`, add a `paper` entry to `catalog.js`. In both cases you should **not** need to touch `index.html` (directory) or anything under `reader/`.

## Content conventions (for the Markdown parts)

- Third-person objective; cover 设计思想 / 实现机制 / 实现原理. Aim at a learner of unknown depth — no "knowledge curse": gloss jargon in `part-00` and back-reference it.
- Filename `source/<id>/part-NN-<kebab>.md`, `NN` from `00`. First line `# 第N篇　标题`; second line `*作者：Amlei　·　更新时间：YYYY-MM-DD*`. (Note: 篇, not 部 — be careful with find/replace that can hit 部分/部署/内部/外部.)
- Mark concrete mechanisms with `文件:行号` so each part doubles as a code-navigation index.
- Cross-references are clickable markdown links to the relative filename: `[第三篇](part-03-tools.md)（工具系统）`. Keep "第N篇" inside the link, the name/section outside.
- `part-00` (preface/overview/concept-glossary/TOC/dependency graph) is written **last** but is the first part.

## Producing a new volume end-to-end

The full methodology (recon → parallel opus deep-dive → synthesis → site) is fixed in the **`pro-to-book` skill** at `skill/pro-to-book/SKILL.md` (also reachable as `.claude/skills/pro-to-book` via a symlink, and invokable with `/pro-to-book`). For any task that means creating or heavily revising a source monograph, read that skill first — it is the authoritative process and supersedes the shorthand in the README.
