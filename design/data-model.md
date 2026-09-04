# 核心数据模型 (document.ts + markdown.ts)

## Region 归一化坐标

`regionSchema` (`src/document.ts:3`) 定义归一化区域: `x` / `y` 取值 `[0,1]`, `width` / `height` 为正且不超过 1, 并通过 `refine` 强制 `x + width <= 1` 且 `y + height <= 1`, 越界即拒绝. 坐标相对 EXIF 旋转后的显示源图. 在 `inspect_source` 输入中, 越界的宽高会被裁剪到图像边界 (`src/image.ts:53`).

## RevisionDraft (markdown 契约)

笔记的持久化格式是 GFM Markdown 字符串 (详见 [markdown.md](markdown.md)). `revisionDraftSchema` (`src/document.ts:83`) 为:

```text
{ markdown: string (非空), audit: RevisionAudit }
```

工具外层仍是 JSON 协议, 但文档主体只传 Markdown 字符串; 修订是全文替换, 没有 JSON patch.

## 审计契约

`RevisionAudit` (`src/document.ts:62`) 包含 `corrections` 与 `uncertainties` 两个数组 (默认空), 审计条目 ID 全局唯一. 审计定位用 quote locator: `target = { quote, occurrence? }` (`auditTargetSchema`, `src/document.ts:18`), `quote` (1..500 字符) 必须在折叠空白 (双侧 `\s+` → 单空格并 trim) 后于可见笔记文本中出现至少 `occurrence ?? 1` 次. 无 Mermaid / math 时由 `revisionDraftSchema` 的 `superRefine` 同步强制; 含渲染依赖内容时暂缓到渲染后, 分别用 Mermaid SVG 中具有有效祖先可见性的标签与去除 TeX annotation 的 KaTeX MathML 语义文本完成最终校验. Mermaid 程序源码、透明 / 隐藏标签与 TeX 命令 / 定界符不属于可见文本; KaTeX 解析失败时实际显示的公式回退文本仍可定位. 失败消息统一为 "Audit {id} quote not found (occurrence N)". 标题定位天然可用 (quote 标题行文本). `correction` 的 `confidence` 门槛为 0.95 (`src/document.ts:37`), `uncertainty` 的 `confidence` 在 `[0,1]` 且需至少 2 个候选 (`src/document.ts:46`).

审计数据仅存在于 session 与 `RevisionDraft`, 渲染管线只消费 markdown, 因此审计不会进入任何渲染产物或 `note.md`.

## 运行时 IR

`parseNoteMarkdown` (`src/markdown.ts:220`) 在单次工具调用内产出 `NoteMarkdown { markdown, tree (带 data-hn-id 锚点的 mdast), structure, mathWarnings }`; tree 是可丢弃 IR, 不持久化. `structure` 由 mdast 派生: `headings` / `blocks` / `tables` / `equations` / `diagrams` / `figures`.
