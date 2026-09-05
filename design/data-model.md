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

`RevisionAudit` 包含 `corrections` 与 `uncertainties` 两个数组（默认空），条目 ID 全局唯一。`target = { quote, occurrence? }`：quote 为 1..500 字符的非空白 Markdown 原文片段；按大小写敏感的原样子串匹配，不折叠空白、不删除标记、不增加词边界。occurrence 默认为 1，允许 1..20，并计入重叠匹配。格式标记、TeX、图片语法和跨行片段都可定位，但不证明对应内容显示在图片中。

`revisionDraftSchema` 在渲染前校验全部引用，失败返回 `invalid_audit`，原 revision 不变。定位失败消息为 "Audit {id} quote not found (occurrence N)"。correction 的 confidence 门槛为 0.95；uncertainty 的 confidence 在 `[0,1]` 且需至少两个候选。

审计数据仅存在于 session 与 `RevisionDraft`, 渲染管线只消费 markdown, 因此审计不会进入任何渲染产物或 `note.md`.

## 临时编译结果

`compileNoteMarkdown` 返回 `CompiledNote { markdown, html, hasTitle, structure, warnings }`。一次调用内完成标准解析、清理与转换，AST 不导出也不持久化。structure 从清理后的 HTML 树统计 headings / blocks / tables / equations / diagrams / figures，不表示视觉内容完整性。

历史运行文件不改写、不迁移。解释旧审计时依据当时的提示词和代码契约，不能把当前源码定位规则追溯应用于旧的可见文本定位。
