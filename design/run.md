# 运行流程与产物 (run.ts + cli.ts)

CLI 命令 (`src/cli.ts:40`):

```
handnote run <image> --config <yaml> --output <dir> [--json]
```

运行目录布局 (由 `executeRun` 分配, `src/run.ts:156`):

| 路径 | 内容 |
|:----:|:----:|
| `original{ext}` | 复制后的源图 |
| `note.md` | 完整运行保留 finalized revision 原字节；partial 运行保留最新已提交 revision |
| `note.png` | 与 note.md 对应的渲染图 |
| `revisions/revision-NNN.md` | 每个成功 revision 的 markdown 原字节, 不参与 cleanup, 保证可从磁盘独立重建 |
| `assets/figures/figure-NNN.png` | `capture_figure` 物化的源图裁片, 被 markdown 引用, 不参与 cleanup |
| `run.json` | 运行 manifest (`RunManifest`) |
| `session/events.jsonl` | 脱敏 session 事件日志 |
| `intermediate/` | 中间产物 (inspections / revisions 渲染), 可由 `saveIntermediateImages` 控制清理 |

`manifest.final` 为 `{ markdown: "note.md", image: "note.png", markdownSha256, imageSha256, revision }`. `finalize_note` 在门控通过后重算磁盘 revision 的 sha256 并要求等于 `state.revision.markdownSha256`, 实现 finalize 绑定被 review 的 revision/hash.

同一模型 step 并发工具调用中, 当前 revision 一旦成功 `finalize_note`, 其他工具的 fatal error 仅保留在脱敏 session 诊断中, 不覆盖完成状态; 根产物提交成功后 manifest 固定为 `complete` / `finalized` / exit code 0. 后续产物写入或 cleanup 失败仍覆盖为 `filesystem` failure.

退出码 (`src/run.ts:338`): `complete` → 0, `partial` → 2, `failed` → 1.
