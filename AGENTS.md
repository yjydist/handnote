# Development invariants

- Runtime code is ESM TypeScript for Bun 1.4 and must remain strict-typecheckable.
- The note contract uses standard GFM, math, Mermaid and sanitized HTML via `src/markdown.ts`. Audit quotes in `src/document.ts` match exact Markdown source substrings; visual fidelity and completeness belong to `review_render`. Images must resolve to captured files inside the current run’s `assets/figures/`; do not infer semantic emptiness or painted-text visibility.
- Provider calls go only through the provider module (`src/provider/`, entry `src/provider/index.ts`). Tests must never call a paid or live model endpoint.
- A complete run requires successful `finalize_note`; any deterministic best-effort output is partial.
- Never persist credentials or Base64 media in session records. Session events are synchronous and sequence-monotonic.
- Keep renderer HTML self-contained and preserve exact configured output width.
- Run `bun test`, `bun run typecheck`, and `bun run check` before handing off changes.

# 项目的唯一的设计文档
请阅读 @design/README.md
