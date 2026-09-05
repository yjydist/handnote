# Handnote

Handnote is a Bun/TypeScript CLI that turns one handwritten-note image into a faithful electronic `note.md` (GitHub Flavored Markdown) and a locally rendered `note.png`. A Mastra agent may inspect source regions, capture figure crops, write and revise the full note, review the render against the source, and finalize only after an unchanged revision passes a later-step review. Model summaries, page commentary, and audit sections are not part of the finished note.

## Install

Requirements: Bun 1.4 and a Node-compatible environment supported by Playwright.

```sh
bun install --frozen-lockfile
bunx playwright install chromium
```

The package registers the `handnote` bin. During development, invoke it with `bun run src/cli.ts` or link/install the package as a CLI.

## Configure

Configuration has no version field and rejects unknown keys. Prompt paths are resolved relative to the YAML file.

```yaml
model:
  baseUrl: https://provider.example/v1
  apiKey: replace-with-your-api-key
  name: vision-model
  timeoutMs: 240000
  maxRetries: 1
prompt:
  file: ./prompts/handnote.md
maxSteps: 18
maxInspectCalls: 3
width: 1600
toolMedia:
  maxEdge: 2048
  jpegQuality: 85
theme: clean
fontFamily: sans-serif
saveIntermediateImages: true
```

`timeoutMs`, `maxRetries`, `maxSteps`, `maxInspectCalls`, `width`, `toolMedia`, `theme`, `fontFamily`, and `saveIntermediateImages` may be omitted to use those shown defaults. `timeoutMs` covers the complete Provider response stream. The first release accepts only `clean` and `sans-serif`. Tool images are deterministically converted to bounded JPEG previews for model input; retained inspection and render artifacts remain PNG. Identical inspections are reused within a run, while the unique-call budget prevents inspection loops from consuming the document, review, and finalization steps.

## Run

```sh
handnote run page.jpg --config handnote.yaml --output ./runs
handnote run page.jpg --config handnote.yaml --output ./runs --json
```

Normal mode prints a short terminal status and run path. `--json` writes exactly one result object to stdout; diagnostics remain on stderr. Exit codes are `0` for complete, `2` for a usable partial result, and `1` when there is no artifact or an unrecoverable error.

Each run directory is named with local time and a sanitized source stem. It always retains the byte-identical `original.<ext>`, `run.json`, and `session/events.jsonl`. Only complete or usable partial runs contain root-level `note.md` and `note.png`. For a complete run, `note.md` is the finalized revision's GFM markdown verbatim. For a partial run, it is the latest committed revision verbatim and has not been finalized. Every committed revision is also retained byte-identical under `revisions/revision-NNN.md`, and `assets/figures/` keeps captured source crops, so each revision is independently rebuildable from disk. When intermediate image retention is disabled, inspection images and revision HTML/PNG files are removed after their hashes are recorded; `revisions/` and `assets/` always survive.

The note and audit contracts are separate. `write_note` and `revise_note` accept `{markdown,audit}`. Markdown uses standard GFM, including links, footnotes and reference-style images, plus KaTeX math, Mermaid diagrams and sanitized HTML. Scripts and event attributes are removed; images must reference captured files in the current run’s `assets/figures/` and are inlined. External media is not downloaded. Only blank or oversized text is rejected at the syntax boundary; successful compilation does not imply visible or complete content.

Audit `target.quote` locates an exact, case-sensitive Markdown source substring, with an optional 1-based `occurrence` for repeated or overlapping matches. Whitespace and markers are preserved: TeX and image syntax are valid locators. Validation occurs before rendering and does not prove that the quoted content appears in the image. `review_render` is responsible for checking visual fidelity and completeness against the source. Audit candidates, evidence, confidence and correction details remain session-only; corrections require confidence of at least `0.95`. A complete run still requires a later-step review and then `finalize_note`, which re-hashes the on-disk revision and refuses a mismatch. Historical runs retain their original audit contract and are not migrated.

## Real-model evaluation

The development-only evaluation runner requires an explicit live-call confirmation and is never invoked by `bun test`:

```sh
bun run eval:real -- \
  --config config.yaml \
  --data ./data \
  --output ./runs/eval \
  --cases 001,005,006,010,012,016 \
  --repeat 1 \
  --concurrency 2 \
  --retry-transient 0 \
  --confirm-live
```

Omit `--cases` to evaluate every supported image in the data directory. Whole-run retries are recorded separately so the generated `eval.json` and `EVAL_REPORT.md` preserve both first-pass and eventual success rates. A `provider_transient` interruption is eligible even when a valid revision makes the run partial. Reports exclude credentials and prompt text while retaining a safe configuration fingerprint, contract checks, step latency, request size, image count, and token/cache/reasoning aggregates.

## Provider requirements

The configured OpenAI-compatible chat endpoint must accept image input and tool calling. Handnote promotes media-bearing tool results into a following user multimodal message because OpenAI-compatible tool messages carry string content. It does not issue separate capability probes or switch models on incompatibility. The first image/tool request and the response following the first promoted media result provide capability evidence.

For DeepSeek-compatible usage responses, `run.json` reports cached and uncached input tokens, reasoning and text output tokens, plus the aggregate cache-hit rate. Completed-step usage is retained even when a later step fails. Request events retain only a SHA-256 fingerprint, byte length, and image count, so identical first-request hashes can be compared without persisting request bodies. Handnote relies on the Provider prompt cache and does not replay cached model responses.

The custom transport retries network failures, timeouts, HTTP 408/409/429, and 5xx responses up to `maxRetries` additional attempts and honors `Retry-After`. Authentication failures, deterministic 4xx responses, and a stream that breaks after its response starts are not retried by Handnote. Generic deterministic 4xx responses use the `provider_rejected` stop reason and are also excluded from whole-run transient retries.

## Debug a session

Read `run.json` first, then correlate `model.step.completed`, `model.attempt.*`, document revision, render review, and terminal events by `seq` in `session/events.jsonl`. For a finalized run, read the revision number from `note.finalized`, find the matching `document.revision.committed`, and inspect its `data.audit`. That audit is the authoritative record of uncertainties and conservative corrections for the final visible note. The repository includes the read-only `debug-note-run` skill at `.agents/skills/debug-note-run/SKILL.md`; it classifies failure and content evidence without calling a Provider or changing artifacts.

Session records recursively redact credential-like fields, Authorization values, URL credentials, and Base64 data. Media appears as `{path,mimeType,sha256,retained}` references.

## Development

```sh
bun test
bun run typecheck
bun run check
```

Tests are offline and must not call a real Provider. The MVP intentionally omits multiple images/models, OCR, human approval, resume/replay, remote tracing, Mastra Memory/Storage/Workflow, and compatibility migrations.
