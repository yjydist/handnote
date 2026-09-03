# 配置项 (config.ts)

配置 schema (`src/config.ts:7`) 与默认值:

| 配置项 | 默认值 | 约束 |
|:----:|:----:|:----:|
| `model.provider` | openai-compatible | 仅 `openai-compatible` |
| `model.baseUrl` | 必填 | 合法 URL |
| `model.apiKey` | 必填 | 非空 |
| `model.name` | 必填 | 非空 |
| `model.timeoutMs` | 240000 | 1000 - 600000 |
| `model.maxRetries` | 1 | 0 - 5 |
| `prompt.file` | 必填 | 非空 |
| `maxSteps` | 18 | 2 - 50 |
| `maxInspectCalls` | 3 | 1 - 8 |
| `width` | 1600 | 640 - 4096 |
| `toolMedia.maxEdge` | 2048 | 640 - 4096 |
| `toolMedia.jpegQuality` | 85 | 50 - 100 |
| `theme` | clean | 仅 `clean` |
| `fontFamily` | sans-serif | 仅 `sans-serif` |
| `saveIntermediateImages` | true | 布尔 |

`prompt.file` 为相对路径时按配置文件所在目录解析 (`src/config.ts:61`), 加载后 prompt 文本内联进 `HandnoteConfig.promptText`.
