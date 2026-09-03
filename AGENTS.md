# Development invariants

- Runtime code is ESM TypeScript for Bun 1.4 and must remain strict-typecheckable.
- `NoteDocument` and patch contracts are defined in `src/document.ts` and `src/patch.ts`; reject incompatible input instead of adding aliases or migrations.
- Provider calls go only through the provider module (`src/provider/`, entry `src/provider/index.ts`). Tests must never call a paid or live model endpoint.
- A complete run requires successful `finalize_note`; any deterministic best-effort output is partial.
- Never persist credentials or Base64 media in session records. Session events are synchronous and sequence-monotonic.
- Keep renderer HTML self-contained and preserve exact configured output width.
- Run `bun test`, `bun run typecheck`, and `bun run check` before handing off changes.

# 项目的唯一的设计文档
请阅读 @design/README.md
