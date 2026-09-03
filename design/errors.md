# 错误模型 (errors.ts)

`HandnoteError` (`src/errors.ts:13`) 携带 `kind` 与 `recoverable` 标志. 10 种 `ErrorKind` (`src/errors.ts:1`):

| kind | 含义 | recoverable |
|:----:|:----:|:----:|
| `validation` | 输入 / 配置 / prompt 校验失败 | 否 |
| `authentication` | Provider 鉴权失败 (401 / 403 等) | 否 |
| `provider_rejected` | Provider 拒绝请求 (4xx) | 否 |
| `provider_transient` | Provider 暂时性故障 (超时 / 429 / 5xx) | 是 |
| `provider_image_incompatible` | Provider 不支持图像输入 | 否 |
| `provider_tools_incompatible` | Provider 不支持工具调用 | 否 |
| `provider_tool_media_incompatible` | Provider 不支持工具结果中的媒体 | 否 |
| `rendering` | 渲染失败 (如 Chromium 缺失) | 否 |
| `filesystem` | 文件系统读写失败 | 否 |
| `internal` | 未预期的内部错误 | 否 |

`recoverable` 为语义标记, 网络层重试由 `createRetryingFetch` 内部完成; 评测脚本据此对 `provider_transient` 整轮重试 (`scripts/real-eval.ts:491`).
