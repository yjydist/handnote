# 渲染器 (renderer.ts)

- 自包含 HTML (`src/renderer.ts:246`): Noto Sans SC 字体, KaTeX, mermaid 全部内联为 base64 或内联脚本, 单文件可离线打开.
- 精确输出宽度 `width`: viewport meta, CSS `width` 与截图 viewport 三者一致, 保证产物宽度精确等于配置值.
- 布局体检 (`src/renderer.ts:12`): 截图时在浏览器内检测横向溢出, 块裁剪, 零尺寸, diagram 渲染失败等, 产出 `LayoutWarning`, 其中 `blocking` 标记是否阻塞 finalize.
- 超高页 (`src/renderer.ts:271`): 高度不超过 12000px 直接整页截图, 否则分段截图后用 sharp 拼合.
