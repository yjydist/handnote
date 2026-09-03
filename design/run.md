# 运行流程与产物 (run.ts + cli.ts)

CLI 命令 (`src/cli.ts:40`):

```
handnote run <image> --config <yaml> --output <dir> [--json]
```

运行目录布局 (由 `executeRun` 分配, `src/run.ts:156`):

| 路径 | 内容 |
|:----:|:----:|
| `original{ext}` | 复制后的源图 |
| `note.json` | 最终结构化 `NoteDocument` |
| `note.png` | 最终渲染图 |
| `run.json` | 运行 manifest (`RunManifest`) |
| `session/events.jsonl` | 脱敏 session 事件日志 |
| `intermediate/` | 中间产物 (inspections / revisions), 可由 `saveIntermediateImages` 控制清理 |

退出码 (`src/run.ts:338`): `complete` → 0, `partial` → 2, `failed` → 1.
