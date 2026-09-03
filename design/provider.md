# Provider 抽象 (provider/)

Provider 调用统一经过目录 `src/provider/`, 入口为 `src/provider/index.ts`. `createModel` (`src/provider/index.ts:26`) 按 `config.model.provider` 在 `Map<string, ProviderAdapter>` 注册表中分派; 新增提供商只需实现一个适配器模块并注册一行, 不改动传输层与归类层.

## 目录结构与关键组件

| 文件 | 作用 |
|:----:|:----:|
| `index.ts` | `createModel` 协议分派 + 公共面 re-export (`src/provider/index.ts:26`) |
| `types.ts` | `ProviderAdapter` / `ProviderStats` / `RetryConfig` / `ProviderModelContext` (`src/provider/types.ts:23`) |
| `primitives.ts` | 协议无关原语: `isRetryableStatus` / `record` / `finiteNumber` / `retryAfter` (`src/provider/primitives.ts:3`) |
| `retry.ts` | 通用传输: `requestFingerprint` + `createRetryingFetch` (`src/provider/retry.ts:9`) |
| `classify.ts` | `classifyProviderError` + `requestContainsSerializedToolMedia` (`src/provider/classify.ts:15`) |
| `openai-compatible.ts` | 唯一适配器: `repair*` / `promoteToolMedia` / `convertDeepSeekUsage` / `openAiCompatibleAdapter` (`src/provider/openai-compatible.ts:276`) |

## ProviderAdapter 抽象

```ts
export interface ProviderAdapter {
  readonly protocol: string;                    // 对应 config.model.provider
  createModel(context: ProviderModelContext): LanguageModelV4;
}
export interface ProviderModelContext {
  config: HandnoteConfig; recorder: SessionRecorder; state: RunState; stats: ProviderStats;
}
```

`ProviderAdapter` 定义位于 `src/provider/types.ts:23`; 当前只注册 `openAiCompatibleAdapter` (`src/provider/openai-compatible.ts:276`).

## 关键组件

- `createRetryingFetch` (`src/provider/retry.ts:39`): 重试 / 指数退避 / 解析 `Retry-After` / 超时控制. 第 6 个可选参数 `repairResponse` (默认恒等) 允许适配器注入线格式修复, 使传输层不依赖任何线格式.
- `repairToolArgumentResponse` (`src/provider/openai-compatible.ts:61`): 修复工具参数尾部多余括号, 由 `openAiCompatibleAdapter` 注入 `createRetryingFetch`.
- `repairOpenAiToolArguments` (`src/provider/openai-compatible.ts:36`): 工具参数修复合集.
- `promoteToolMedia` (`src/provider/openai-compatible.ts:224`): 将工具返回的媒体提升为后续 user 消息, 兼容不支持工具内媒体的端点.
- `convertDeepSeekUsage` (`src/provider/openai-compatible.ts:94`): DeepSeek 用量字段到 `LanguageModelV4Usage` 的映射, 属 OpenAI 兼容端点 quirk, 归为适配器内部细节.
- `classifyProviderError` (`src/provider/classify.ts:15`): 将底层错误归类为 `HandnoteError` 的对应 kind.
- `requestFingerprint` (`src/provider/retry.ts:9`): 计算请求体 sha256 / 字节数 / 图片数, 供 session 记录. 其 `imageCount` 是 OpenAI `image_url` 启发式, 仅作遥测, 非正确性关键.