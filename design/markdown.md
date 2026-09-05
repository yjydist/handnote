# Markdown 契约

GFM Markdown 是 canonical 持久化格式。保留每次提交的原字节；编译过程中使用的 mdast / hast 不持久化。审计定位源码，视觉忠实度与内容完整性由模型通过 `review_render` 对照源图检查。

`compileNoteMarkdown` 使用标准库管线：

`remark-parse → remark-gfm / remark-math → remark-rehype → rehype-raw → rehype-sanitize → 本地资源与结构处理 → rehype-katex → rehype-stringify`

普通链接、引用式链接、脚注、引用式图片和 HTML 按库规则处理。HTML 使用默认 sanitize schema，仅增加公式转换所需的 code class。清理先于 KaTeX，遵循 [rehype-sanitize 的数学示例](https://github.com/rehypejs/rehype-sanitize#example-math)。脚本和事件属性不会进入渲染 HTML。清理后的 ID 保留库的防冲突前缀，本页链接同步指向新 ID，脚注引用和返回链接可用。

不对 frontmatter 外观、语言名大小写、`math` 围栏额外报错：没有 frontmatter 扩展，类似文本按普通 Markdown 解析；公式由 remark-math / rehype-katex 的标准规则转换；只有 `language-mermaid` 的代码块转换为 Mermaid，其他大小写按普通代码渲染。

清理后的 HTML 树统一进行本地图片校验和内联、结构统计、块锚点赋值、独立图片说明及公式 / Mermaid 转换。Markdown、引用式和 HTML 图片（包括用 `srcset` 库解析的 picture 候选图片）均只能读取当前运行 `assets/figures/` 下的裁片；检查真实路径，拒绝越界符号链接。独立图片段落转为 `figure`，非空 alt 作为 `figcaption`。块锚点供布局和图表错误定位；KaTeX 替换 display math 时保留外层锚点。一次编译返回 `CompiledNote { markdown, html, hasTitle, structure, warnings }`，渲染器不再解析源码。

## 输入与资源错误

工具将 `MarkdownValidationError` 包装为可修复的 `invalid_markdown`，包含错误码、说明和可用的行号：

| code | 条件 |
| --- | --- |
| `empty_document` | 输入为空字符串或全为空白 |
| `markdown_too_large` | 超过 200,000 字符 |
| `invalid_image_path` | 图片不是当前运行 `assets/figures/` 内的本地文件，或真实路径越界 |
| `missing_figure` | 引用的本地裁片不存在 |
| `external_resource` | 渲染请求被资源白名单拦截，或生成结果仍含非内联媒体 |

程序不推断“语义空白”。非空的纯语法、被清理的 HTML、透明图形或隐藏公式均可提交。成功提交与源码引用匹配不证明图片中存在这些内容。KaTeX 转换失败产生非阻塞 `equation_fallback`；Mermaid 渲染错误和布局溢出仍阻止 finalize。

Mermaid 源码不做自写 HTML、click、URL 或属性扫描。使用 Mermaid strict 模式和 Chromium 请求白名单限制运行时资源，详见 [renderer.md](renderer.md)。普通链接可以保留，外部媒体不会下载。

源码 quote 的精确匹配规则见 [data-model.md](data-model.md)。历史运行保留原样，按生成时契约解释审计，不迁移产物。
