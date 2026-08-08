# 处理不同来源（references/sources.md）

> 仅在需要处理某种具体来源时读本文件。SKILL.md 本身是来源无关的；这里讲常见来源怎么读全、怎么抽实质内容。
> 本仓库就是用 study-notes skill 从 opencode 会话整理出来的，opencode 部分即当时的实际做法。

## 通用原则（任何来源）

1. **读全**——质量取决于读到的素材完整度。来源很大就分批，宁可慢不要省略。
2. **抽实质**——问答/对话里，"问题"是线索，"讲解/推理/证据"才是素材。剔除寒暄、进程噪声、纯操作日志。
3. **落盘再读**——大来源先抽取到临时目录分文件，再逐个精读，避免一次性塞爆上下文。

---

## 来源：opencode 会话（SQLite）

opencode 把会话存在 SQLite 里（macOS 默认 `~/.local/share/opencode/opencode.db`）。表结构：
- `session`：会话元数据（id、title、directory、time_created/updated）。
- `message`：消息（`data` JSON 含 `role`）。
- `part`：消息的组成部分（`data` JSON 含 `type`：`text` / `reasoning` / `step-start` / 工具调用等）。

### 定位会话

按工作目录或时间筛选：

```bash
sqlite3 ~/.local/share/opencode/opencode.db \
  "SELECT id, title, directory, datetime(time_created/1000,'unixepoch','localtime') \
   FROM session WHERE directory LIKE '%<项目目录>%' ORDER BY time_updated DESC LIMIT 20;"
```

### 抽取实质内容（只取 text，跳过 reasoning 噪声）

reasoning 是智能体的中间思考，不是"讲解成品"，会引入大量噪声。只抽 user 的提问 + assistant 的 text（最终讲解）：

```python
import sqlite3, json
con = sqlite3.connect(DB); cur = con.cursor()
cur.execute("""
    SELECT m.data, p.data
    FROM part p JOIN message m ON p.message_id = m.id
    WHERE p.session_id=? AND json_extract(p.data,'$.type')='text'
    ORDER BY p.time_created, p.id
""", (sid,))
for mdata, pdata in cur.fetchall():
    m, p = json.loads(mdata), json.loads(pdata)
    role = "USER" if m.get("role")=="user" else "ASSISTANT"
    print(f"===== {role} =====\n{p.get('text','').strip()}")
```

> 关键：**只抽 `type='text'`，不要带 `reasoning`**。带 reasoning 会让文件膨胀数倍且噪声极大。
> 如果某个 text 只是一句"让我查证一下"这类进程话术，可一并剔除。

### 跨会话归类

一次学习可能跨多个会话（每个会话一个主题）。先列出所有相关会话的 title，按 title 判断主题，
再把同主题会话的内容合并到同一章。例如 title 含"Tool"的会话归"工具"章，含"storage/Token"的归"存储"章。

---

## 来源：聊天记录文件（jsonl/txt/csv）

逐行解析，按角色（user/assistant）分段。同样**只取讲解正文**，跳过工具调用的原始 payload、
思考链、系统提示等噪声。读不到完整讲解时，直接问用户要更完整的来源，不要凭残缺内容硬写。

## 来源：文档/文章（markdown/html）

这类已经成品化，通常是"按主题"而非"按问答"。直接通读，按文档自带的章节边界拆分到对应章即可，
再以第三人称重述（原文若是第二人称教程体，要改写成剖析体）。

## 来源：粘贴的文本 / 多个混合来源

用户可能直接粘贴一段或多段文本。先问清楚每段属于哪个功能领域，再归类。来源不明确归属时，
列出来让用户确认，不要自行猜测强行归章。

---

## 何时向用户要更多来源

- 只有提问、没有讲解 → 一定补全讲解再写。
- 讲解被截断/只有摘要 → 要完整版。
- 某个功能领域素材明显单薄 → 明确告诉用户"这章素材不足，需要补充 X"，不要硬凑。
