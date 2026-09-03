# Agent 协议 (agent.ts + tools/)

循环由 Mastra `Agent.generate` 的多步机制驱动 (`src/agent.ts:94`), `stopWhen` 依赖 `state.finalized || state.fatalError` (`src/agent.ts:110`). 首条 user 消息携带源图与任务说明, 之后每步由模型自主选择工具.

5 个工具 (入口 `src/tools/index.ts:11` 组装):

| 工具 | 作用 |
|:----:|:----:|
| `inspect_source` | 裁剪源图 1 到 8 个归一化区域回图, 受 `maxInspectCalls` 预算约束, 超预算返回可修复错误 (`src/tools/inspect-source.ts:11`) |
| `write_document` | 校验并提交第一份完整初稿 (`{ document, audit }`), 渲染并 commit revision (`src/tools/write-document.ts:9`) |
| `patch_document` | 原子应用一批 patch 操作, 渲染并 commit 新 revision (`src/tools/patch-document.ts:9`) |
| `review_render` | 返回当前 revision 渲染图与布局警告, 供模型对照源图审查 (`src/tools/review-render.ts:7`) |
| `finalize_note` | 定稿, 受收敛门控约束 (`src/tools/finalize-note.ts:7`) |

工具工厂统一签名 `(context: ToolContext, runtime: ToolRuntime)`; `index.ts` 先经 `createToolRuntime` (`src/tools/shared.ts:40`) 创建共享闭包状态 (`modelMedia` 缓存 / `fatal` / `mediaOutputWithFatal`), 再组装 5 个工具. `ToolContext` 定义于 `src/tools/types.ts:5`; `toolError` / `remainingSteps` / `layoutSummary` 为纯函数 (`src/tools/shared.ts:6`), `inspect_source` 的 `inspectSequence` 与 `inspections` 缓存为工厂局部 (`src/tools/inspect-source.ts:15`).

收敛门控由 `RunState.canFinalize` (`src/state.ts:77`) 实现: 必须满足 (渲染 → 后续步审查 → 再后续步 finalize) 的时序, 且审查时无阻塞布局警告; 任何 commit (变更) 都会产生新 revision, 使旧审查资格失效. 收敛出口为 `complete` / `partial` / `failed`, 对应 `stopReason` 取值 `finalized` / `max_steps` / `model_stopped` / `max_steps_no_revision` / `model_stopped_no_revision` / 错误 kind (`src/run.ts:238`).