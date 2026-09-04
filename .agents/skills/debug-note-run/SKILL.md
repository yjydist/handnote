---
name: debug-note-run
description: Diagnose a Handnote run directory from its local run manifest, session events, revision markdown, audit metadata, and media evidence. Use for explaining failed, partial, or semantically wrong Handnote runs and proposing the smallest evidence-backed fix; do not use to invoke a model or modify run artifacts.
---

# Debug a Handnote run

Work read-only. Never invoke a Provider, make a paid model call, edit the run directory, retry the run, or expose a credential recovered from local files.

Start with `run.json`, then follow its file references into `session/events.jsonl`, `note.md`, `revisions/revision-NNN.md`, and retained intermediate artifacts. Verify hashes when corruption or mismatched media is plausible: `manifest.final.markdownSha256` must equal the sha256 of both `note.md` and the finalized `revisions/revision-NNN.md`. Treat absent intermediate images as expected when `saveIntermediateImages=false` and use their recorded hash plus `retained:false` event metadata; `revisions/` and `assets/` always survive cleanup.

For a complete run, find the `note.finalized` event and use its revision number to select the matching `document.revision.committed` event. Read uncertainties and conservative corrections from `data.audit` on that revision. Audit metadata is intentionally session-only: `note.md` must contain only the visible GFM note and must not contain audit material or observer commentary. Confirm each audit target quote appears in the revision markdown (whitespace folded, honoring `occurrence`) and that the selected or corrected content is present as ordinary note content rather than as a visible audit appendix.

Build a chronological evidence chain from monotonic event `seq` values. Distinguish model steps from `model.attempt.*` transport retries. Cite the smallest relevant set of event sequence numbers and paths.

Classify the primary cause as one of:

- preflight/configuration;
- authentication;
- transient Provider exhaustion;
- image, tool-calling, or tool-result-media incompatibility;
- markdown or audit validation (`invalid_markdown` issues, quote-locator failures);
- rendering or blocking layout;
- model protocol/step-budget behavior;
- filesystem or internal consistency (including finalize hash mismatch when the on-disk revision file no longer matches the reviewed revision).

Check for a secondary failure only when it materially changed the terminal status. A `partial` result is expected when a valid revision exists but finalization did not succeed; `complete` requires a successful `note.finalized` event. For finalization failures, compare the revision's render step, later review step, finalization step, mutation history, blocking warnings, and the on-disk revision hash.

Report the observed status and primary cause, the evidence chain, and one minimal repair suggestion. Separate facts from inference. If evidence is insufficient, name the exact missing artifact or event instead of guessing.
