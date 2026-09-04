# Handnote 设计文档

## 概述

Handnote 是一个 Agent 项目: 输入一张手写笔记图片, 通过 VLM (视觉语言模型) 在 Agent loop 中逐步收敛, 最终产出结构化笔记与自包含渲染图.

- 输入: 单张手写笔记图片 (PNG / JPEG / WebP).
- 处理方式: 由 Mastra `Agent.generate` 驱动的多步工具调用循环, 让 VLM 反复 (起草 → 渲染 → 对照源图审查 → 修订), 向最优结果收敛 (见 `prompts/handnote.md`).
- 输出: 一次完整运行产出 `note.md` (canonical GFM markdown) + `note.png` (自包含 HTML 渲染出的图) + `run.json` (运行 manifest) + `revisions/revision-NNN.md` (每个成功 revision 的原字节, 可从磁盘独立重建) + `session/events.jsonl` (脱敏 session 日志).
- 核心设计原则: 文档与审计分离. 纠错 (`corrections`) 与不确定项 (`uncertainties`) 只写入 session 审计 (`RevisionAudit`), 永远不进入渲染产物; 渲染产物只呈现源图作者视角的笔记本身, 不含任何观察者评论或审计材料.
- Markdown 契约: GFM Markdown 是 canonical 持久化格式, mdast 是可丢弃运行时 IR (单次工具调用内 parse → validate → transform, 不持久化); 严格拒绝 raw HTML / 任何链接 / frontmatter / 非本地图片 (详见 [markdown.md](markdown.md)).

## 项目结构

| 文件/目录 | 作用 |
|:----:|:----:|
| `src/cli.ts` | CLI 入口, 定义 `handnote run` 命令与退出码 (`src/cli.ts:26`) |
| `src/run.ts` | 运行编排, 校验输入, 加载配置, 驱动 agent, 提交产物 (`src/run.ts:156`) |
| `src/config.ts` | 配置 schema 与加载, 解析 YAML 并内联 prompt 文本 (`src/config.ts:41`) |
| `src/document.ts` | 契约 schema, `Region` / quote-locator 审计 / `revisionDraftSchema` (`src/document.ts:83`) |
| `src/markdown.ts` | unified 管线, 严格 GFM 校验, 锚点, 自包含 HTML (`src/markdown.ts:220`) |
| `src/image.ts` | 图像处理, `inspect_source` 裁剪, `capture_figure` 物化, 模型预览 (`src/image.ts:239`) |
| `src/provider/` | Provider 抽象目录, 入口 `index.ts` 协议分派; `retry.ts` 重试传输; `openai-compatible.ts` 唯一适配器 (`src/provider/index.ts:26`) |
| `src/agent.ts` | Agent 循环, 构造 Mastra `Agent` 并执行 `generate` (`src/agent.ts:67`) |
| `src/tools/` | 7 个 agent 工具目录, 入口 `index.ts` 组装; `shared.ts` 公共闭包状态 (`src/tools/index.ts:11`) |
| `src/renderer.ts` | HTML 渲染与截图, 布局体检与超高页拼合 (`src/renderer.ts:271`) |
| `src/state.ts` | 运行状态机, revision 提交, 审查资格与 finalize 门控 (`src/state.ts:15`) |
| `src/session.ts` | session 记录器, 同步追加 events.jsonl (`src/session.ts:18`) |
| `src/redact.ts` | 脱敏引擎, 秘密 / URL 凭据 / Base64 清除 (`src/redact.ts:163`) |
| `src/errors.ts` | 错误模型, `HandnoteError` 与 10 种 `ErrorKind` (`src/errors.ts:1`) |
| `src/utils.ts` | 通用工具, sha256, 原子写入, 唯一目录分配 (`src/utils.ts:52`) |
| `prompts/` | Agent 提示词 (`prompts/handnote.md`), 描述完整工具协议与收敛规则 |
| `scripts/` | 辅助脚本, `real-eval.ts` 为付费真实模型评测套件 (`scripts/real-eval.ts:500`) |
| `data/` | 测试图片, 18 张手写笔记样例 (工程 / 物理 / 几何 / 编程等) |
| `tests/` | 单元与集成测试, 覆盖 markdown / config / run / renderer / agent-loop 等 |
| `runs/` | 运行产物根目录示例 (由 `--output` 指定, 每次运行分配唯一子目录) |

## 文档索引

| 文件 | 内容 |
|:----:|:----:|
| [architecture.md](architecture.md) | 架构图, 模块依赖分层与端到端数据流 |
| [data-model.md](data-model.md) | 核心数据模型 (`src/document.ts` + `src/markdown.ts`) |
| [markdown.md](markdown.md) | Markdown 契约与 unified 管线 (`src/markdown.ts`) |
| [agent.md](agent.md) | Agent 协议 (`src/agent.ts` + `src/tools/`) |
| [provider.md](provider.md) | Provider 抽象 (`src/provider/`) |
| [renderer.md](renderer.md) | 渲染器 (`src/renderer.ts`) |
| [run.md](run.md) | 运行流程与产物 (`src/run.ts` + `src/cli.ts`) |
| [errors.md](errors.md) | 错误模型 (`src/errors.ts`) |
| [config.md](config.md) | 配置项 (`src/config.ts`) |
