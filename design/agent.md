# Agent 协议 (agent.ts + tools/)

循环由 Mastra `Agent.generate` 的多步机制驱动 (`src/agent.ts:94`), `stopWhen` 依赖 `state.finalized || state.fatalError` (`src/agent.ts:110`). 首条 user 消息携带源图与任务说明, 之后每步由模型自主选择工具.

7 个工具 (入口 `src/tools/index.ts:11` 组装):

| 工具 | 作用 |
|:----:|:----:|
| `inspect_source` | 裁剪源图 1 到 8 个归一化区域回图, 受 `maxInspectCalls` 预算约束, 超预算返回可修复错误 (`src/tools/inspect-source.ts:11`) |
| `capture_figure` | 把一个源图区域物化为 `<run>/assets/figures/figure-NNN.png` 本地 asset 并返回相对路径, 供标准 image 语法引用; 相同区域以共享 promise 去重, 首次调用和缓存命中共用 fatal 分类, 失败时清除缓存以允许重试 (`src/tools/capture-figure.ts:11`) |
| `read_note` | 返回当前 revision 的完整 markdown 与 sha256, 供全文修订前原样恢复 (`src/tools/read-note.ts:6`) |
| `write_note` | 校验并提交第一份完整初稿 (`{ markdown, audit }`), 渲染, 落盘 `revisions/revision-NNN.md` 并 commit revision; 已有 revision 时返回可修复 `revision_exists` (`src/tools/write-note.ts:121`) |
| `revise_note` | 全文替换提交新 revision, 同一管线; 无 revision 时返回 `no_revision` (`src/tools/revise-note.ts:11`) |
| `review_render` | 返回当前 revision 渲染图, 布局警告与 `markdownSha256`, 供模型对照源图审查 (`src/tools/review-render.ts:7`) |
| `finalize_note` | 定稿; 在收敛门控之上重算磁盘 revision 的 sha256 并要求等于被审查 revision 的 hash, 不等则 fatal `filesystem` (`src/tools/finalize-note.ts:7`) |

工具工厂统一签名 `(context: ToolContext, runtime: ToolRuntime)` (`read_note` 无副作用, 不需要 runtime); `index.ts` 先经 `createToolRuntime` (`src/tools/shared.ts:40`) 创建共享闭包状态 (`modelMedia` 缓存 / `fatal` / `mediaOutputWithFatal`, purpose 联合类型含 `inspect_source` / `review_render` / `capture_figure`), 再组装 7 个工具. `ToolContext` 定义于 `src/tools/types.ts:5`; `toolError` / `remainingSteps` / `layoutSummary` 为纯函数 (`src/tools/shared.ts:6`).

`write_note` 与 `revise_note` 共享 `commitNoteDraft`：`revisionDraftSchema` 校验结构和全部源码 locator（失败 → 可修复 `invalid_audit`）→ `compileNoteMarkdown` 编译、清理与资源校验 → 渲染截图（资源错误 → 可修复 `invalid_markdown`）→ revision markdown 原字节落盘 → `state.commit`。失败不替换当前 revision。审计只定位源码，不验证可见文字或语义非空；模型必须在 `review_render` 中检查实际视觉内容与源图的差异。渲染是隐式的，没有 render_note 工具。

收敛门控由 `RunState.canFinalize` (`src/state.ts:77`) 实现: 必须满足 (渲染 → 后续步审查 → 再后续步 finalize) 的时序, 且审查时无阻塞布局警告; 任何 commit (变更) 都会产生新 revision, 使旧审查资格失效. 收敛出口为 `complete` / `partial` / `failed`, 对应 `stopReason` 取值 `finalized` / `max_steps` / `model_stopped` / `max_steps_no_revision` / `model_stopped_no_revision` / 错误 kind (`src/run.ts:238`).
