# 渲染器 (renderer.ts)

- 输入为 `NoteMarkdown` IR (含锚点 mdast), 经 `noteMarkdownToHtml` (`src/markdown.ts:365`) 的 unified 管线生成 HTML 主体 (详见 [markdown.md](markdown.md)); `renderDocument` (`src/renderer.ts:288`) 负责套自包含外壳与截图, 并返回持久化 `render` 与仅供提交前语义 / audit 校验的瞬时 `semanticEvidence`. Mermaid 证据来自成功 SVG 中通过浏览器 `checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })` 和尺寸检查的 `text` / `foreignObject`, 因而会继承祖先的 `display` / `visibility` / `opacity`, 再按视觉 reading order 排序; SVG 中实际可见且有 fill / stroke 的图形用于判断 diagram 是否有内容. math 证据来自递归提取的 KaTeX MathML 语义内容, 排除 annotation / mphantom 子树及计算样式中隐藏或完全透明的文字; 不使用辅助 MathML 容器尺寸判断, 以保留 smash 等仍绘制文字的公式, KaTeX error 则使用实际显示的 fallback. Markdown 图片按文档序提取可见 figcaption, 无说明的图片保留空文本占位, 并排除 Mermaid 内部图片. 这些证据及渲染后禁止内容标志不进入 state / manifest / session.
- 自包含 HTML (`src/renderer.ts:78`): Noto Sans SC 字体, KaTeX, mermaid 全部内联为 base64 或内联脚本, 单文件可离线打开.
- 精确输出宽度 `width`: viewport meta, CSS `width` 与截图 viewport 三者一致, 保证产物宽度精确等于配置值.
- 布局体检 (`src/renderer.ts:11`): 截图时在浏览器内检测横向溢出, 块裁剪, 零尺寸, diagram 渲染失败等, 产出 `LayoutWarning`, 其中 `blocking` 标记是否阻塞 finalize. 布局检查与 mermaid `.error-icon` 定位查询 `[data-hn-id]` 锚点 (由 markdown 管线赋值).
- 数学警告 (`equation_fallback`, 非 blocking) 在校验期由 markdown 管线预检产生, 随 `mathWarnings` 并入渲染 warnings.
- 超高页 (`src/renderer.ts:195`): 高度不超过 12000px 直接整页截图, 否则分段截图后用 sharp 拼合.
- Chromium 请求白名单: 截图 context 通过 `route` 仅放行当前生成 HTML 的精确 `file:` URL 与 `data:` URL, abort 其他本地文件、HTTP、blob 等一切资源请求, 兜底保证渲染期无额外文件读取或网络出口 (上游 markdown 校验已拒绝外部资源).
- Mermaid 防御性检查: 浏览器渲染完成后扫描 SVG / foreignObject 中的链接、图片与 `on*` 事件属性; 即使未来 Mermaid 新语法绕过源码层检查, 也以 `invalid_markdown` 阻止提交.
