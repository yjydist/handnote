# Patch 契约 (patch.ts)

`patchOperationSchema` (`src/patch.ts:20`) 按 `op` 区分为 10 种操作:

- `set_document_title` / `set_section_title`: 设置标题, 传 `null` 表示删除.
- `insert_block` / `replace_block` / `move_block` / `delete_block`: 块级增删改移, 位置由 `position` (`start` / `end` / `before` / `after`) 指定.
- `upsert_correction` / `remove_correction` / `upsert_uncertainty` / `remove_uncertainty`: 审计条目的 upsert 与删除.

`patchBatchSchema` (`src/patch.ts:73`) 要求一次 1 到 100 条操作. `applyPatch` (`src/patch.ts:128`) 具有原子语义: 先 `structuredClone` 当前 `RevisionDraft`, 顺序应用全部操作, 最后整体 `revisionDraftSchema.parse`; 任一操作失败或最终校验失败, 整个批次都不生效 (调用方得到错误, 原 draft 不变).
