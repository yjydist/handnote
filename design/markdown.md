# Markdown 契约 (markdown.ts)

## 定位

GFM Markdown 是笔记的 canonical 持久化格式 (模型的心智模型与磁盘产物); mdast 是可丢弃运行时 IR, 仅在单次工具调用内 parse → validate → transform, 从不持久化 (`note.ast.json` 不存在).

## 校验规则 (`parseNoteMarkdown`, `src/markdown.ts:220`)

违规产出 `MarkdownIssue { code, message, line? }`, 工具层转为可修复 `invalid_markdown` 错误:

| code | 触发条件 |
|:----:|:----:|
| `markdown_too_large` | 超过 200_000 字符 (`maxMarkdownLength`) |
| `empty_document` | mdast 不含可见文本、非空普通 code、任务状态、本地图片或等待渲染确认的 math / Mermaid；空 heading / code / list / table 与纯分隔线均为空文档 |
| `frontmatter_unsupported` | 首行 `---` (文本预检, 不用 remark-frontmatter) |
| `raw_html` | 任何 mdast `html` 节点 (含段内 inline HTML), 以及 mermaid code block 内的 HTML markup (含普通 / 闭合 / 自闭合 / 大小写 / 跨行属性标签, 注释, 声明, CDATA 与 processing instruction) |
| `link_not_allowed` | 任何 `link` (含 GFM autolink literal, 裸 URL 即 link), 非图片 `definition`, footnote reference/definition; 含 mermaid code block 内行首或分号分隔的 click 指令 / markdown 链接 / 任意大小写的 `img` 节点属性 / URL scheme `https?://` (静态文本校验) |
| `invalid_mermaid_fence` | Mermaid fence 的语言名不是精确小写 `mermaid` |
| `invalid_image_syntax` | 引用式图片 (含未定义、折叠和快捷形式); 图片仅允许内联本地语法 |
| `invalid_image_path` | `image.url` 不匹配 `^assets/figures/[A-Za-z0-9][A-Za-z0-9._-]*\.png$` |
| `unknown_image` | 引用的 asset 文件在 run 目录下不存在 |

同一 code+line 去重. 数学预检不是校验错误: 每个 `math` / `inlineMath` 节点用 `katex.renderToString({ throwOnError: true })` try/catch, 失败产出非 blocking `equation_fallback` warning (`elementId` 取最近块锚点).

## 锚点 (`data-hn-id`)

校验通过后, 校验 walk 给每个块级 mdast 节点 (paragraph / heading / code / blockquote / list / table / math / thematicBreak) 按文档序赋 `dataHnId = "hn-NNNN"`, 同时在 anchor map 登记块节点自身. 属性经 remark-rehype 的 `data.hProperties` 传递到 hast 后序列化为 `data-hn-id`. code fence 的锚点落在 `<code>` 而非 `<pre>` 上, mermaid 替换时搬运到 `pre`; display math 在 KaTeX 转换前增加保留锚点的块级包装. 渲染器布局检查与 mermaid 错误定位查询 `[data-hn-id]` (替代旧 `[data-block-id]`).

## 渲染管线 (`noteMarkdownToHtml`, `src/markdown.ts:365`)

remark-parse → remark-gfm / remark-math (在 parse 阶段) → 校验 walk → 锚点 walk → remark-rehype → inline hast 变换插件 → rehype-katex → rehype-stringify.

inline 变换插件在 KaTeX 前执行 Mermaid 替换、display math 锚点包装和图片处理:

1. mermaid swap: `<pre><code class="language-mermaid">` 替换为 `<pre class="mermaid" data-hn-id>text</pre>` (事后变换而非自定义 code handler, 避免重实现其他语言的默认渲染);
2. 图片内联: `<img src="assets/figures/*.png">` 从已校验的磁盘 asset 读出并改写为 `data:image/png;base64` (HTML 落在 `intermediate/revisions/` 下, 相对路径无法解析, 且产物必须自包含);
3. 独立图片段落 (`<p>` 只含一个 `<img>`) 包成 `<figure>` + `<figcaption>{alt}</figcaption>` (alt 非空时), 锚点搬到 `figure`.

## 禁止事项

自定义 Markdown 语法, 自定义 mdast 节点, directive, raw HTML, frontmatter, 任何链接 (外部 URL 写成 inline code), 引用式图片, 外部资源请求. 数学只用 `$...$` / `$$...$$` (KaTeX), 非公式美元符号必须转义为 `\$`; Mermaid 只用语言名精确为小写 `mermaid` 的标准 fenced code block, block 内不得包含 HTML markup 或通过标签嵌入媒体; 源图裁片先经 `capture_figure` 物化为本地 asset 再用标准内联 image 语法引用. Markdown 非空检查与 audit quote-locator 共用 `markdown-semantics.ts` 的 mdast 投影; quote 在 heading / paragraph / table cell / 普通 code / image alt 的可见文本中定位, Mermaid 只使用渲染 SVG 的可见 text / foreignObject 标签, math 只使用排除 TeX annotation 后的 KaTeX MathML 语义文本 (解析失败时使用可见 fallback), 两者均不使用源码. 块间不拼接, ASCII 单词和数字遵守词边界, occurrence 允许重叠命中.
