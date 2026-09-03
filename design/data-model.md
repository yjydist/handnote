# 核心数据模型 (document.ts)

## Region 归一化坐标

`regionSchema` (`src/document.ts:3`) 定义归一化区域: `x` / `y` 取值 `[0,1]`, `width` / `height` 为正且不超过 1, 并通过 `refine` 强制 `x + width <= 1` 且 `y + height <= 1`, 越界即拒绝. 坐标相对 EXIF 旋转后的显示源图. 在 `inspect_source` 输入中, 越界的宽高会被裁剪到图像边界 (`src/image.ts:53`).

## Block 8 种 discriminated union

`blockSchema` (`src/document.ts:183`) 按 `type` 区分为 8 种:

| type | 字段要点 | 关键约束 |
|:----:|:----:|:----:|
| `paragraph` | `text` | 文本非空 |
| `bullet_list` | `items` (递归 `text` + `children`) | 至少 1 项 |
| `numbered_steps` | `steps` (字符串数组) | 至少 1 步 |
| `callout` | `tone` (`info` / `warning` / `tip`) + `text` | tone 枚举 |
| `table` | `headers` + `rows` | 每行长度必须等于表头数 (`src/document.ts:74`) |
| `equation` | `latex` + 可选 `label` | latex 非空 |
| `diagram` | `kind` (`flowchart` / `mindmap` / `sequence`) + `nodes` + `edges` + 可选 `groups` | 节点 id 唯一; 边引用必须存在; group 不重叠; mindmap 必须单根连通树 (`src/document.ts:111`) |
| `source_figure` | `region` + 可选 `caption` | 直接引用源图区域, 无 `sources` |

除 `source_figure` 外, 各块均可携带 `sources` (归一化区域数组, 至少 1 项) 记录出处.

## Section 与 NoteDocument

`Section` (`src/document.ts:195`) 递归嵌套: `id` + 可选 `title` + `blocks` + 可选 `sections`. `noteDocumentSchema` (`src/document.ts:242`) 要求 `title` 可选, `sections` 非空, 并通过 `superRefine` 保证全文档内 section / block / diagram node / diagram group 的 ID 全局唯一.

## 审计契约

`RevisionAudit` (`src/document.ts:275`) 包含 `corrections` 与 `uncertainties` 两个数组 (默认空), 审计条目 ID 全局唯一. 每个条目通过 `target` (`document_title` / `section_title` / `block`) 指向文档中真实存在的对象; `correction` 的 `confidence` 门槛为 0.95 (`src/document.ts:227`), `uncertainty` 的 `confidence` 在 `[0,1]` 且需至少 2 个候选 (`src/document.ts:238`). `RevisionDraft` (`src/document.ts:295`) 为 `{ document, audit }`, 其 `superRefine` 校验每个审计 `target` 必须真实存在. 审计数据仅存在于 session 与 `RevisionDraft`, 渲染器只消费 `document`, 因此审计不会进入任何渲染产物.
