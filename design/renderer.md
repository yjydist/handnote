# 渲染器 (renderer.ts)

- 输入为 `NoteMarkdown` IR (含锚点 mdast), 经 `noteMarkdownToHtml` (`src/markdown.ts:365`) 的 unified 管线生成 HTML 主体 (详见 [markdown.md](markdown.md)); `renderDocument` (`src/renderer.ts:271`) 只负责套自包含外壳与截图.
- 自包含 HTML (`src/renderer.ts:78`): Noto Sans SC 字体, KaTeX, mermaid 全部内联为 base64 或内联脚本, 单文件可离线打开.
- 精确输出宽度 `width`: viewport meta, CSS `width` 与截图 viewport 三者一致, 保证产物宽度精确等于配置值.
- 布局体检 (`src/renderer.ts:11`): 截图时在浏览器内检测横向溢出, 块裁剪, 零尺寸, diagram 渲染失败等, 产出 `LayoutWarning`, 其中 `blocking` 标记是否阻塞 finalize. 布局检查与 mermaid `.error-icon` 定位查询 `[data-hn-id]` 锚点 (由 markdown 管线赋值).
- 数学警告 (`equation_fallback`, 非 blocking) 在校验期由 markdown 管线预检产生, 随 `mathWarnings` 并入渲染 warnings.
- 超高页 (`src/renderer.ts:195`): 高度不超过 12000px 直接整页截图, 否则分段截图后用 sharp 拼合.
