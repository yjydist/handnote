# 渲染器

`renderDocument` 消费 `compileNoteMarkdown` 返回的 `CompiledNote`，为临时 HTML 添加自包含外壳并截图，返回 `RenderResult`。Noto Sans SC、KaTeX 字体 / 样式与 Mermaid 脚本全部内联，输出可离线打开。

Mermaid 使用 strict 模式。Chromium 请求白名单仅放行当前 HTML 的精确 `file:` URL 和 `data:` URL，其他文件与网络请求均中止。生成结果仍需加载非内联媒体时返回可修复的 `external_resource`，普通链接不属于媒体请求。

布局检查使用编译时的 `[data-hn-id]` 锚点，检测横向溢出、块裁剪和 Mermaid 渲染错误并给出阻塞警告。编译器提供的 KaTeX fallback 警告不阻塞定稿。渲染器不提取审计文本，不检查文字颜色、透明度、MathML 语义、图形绘制或图片说明的可见性。

viewport meta、CSS 和截图使用配置宽度；即使内容溢出，截图宽度仍精确等于该值。高度不超过 12,000px 时一次截图，更高的页面分段截图后用 sharp 拼合。

`review_render` 返回当前 revision 的图片供模型与源图逐项比较。源码审计只能定位 Markdown 字节中的片段；内容是否显示、是否完整、是否忠实于源图由这一步判断。必须在提交后的模型步骤审查，再在后续步骤 finalize，任何修订都会使旧审查资格失效。
