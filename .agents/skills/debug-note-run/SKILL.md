---
name: debug-note-run
description: Diagnose a Handnote run directory from its local run manifest, session events, revision markdown, audit metadata, and media evidence. Use for explaining failed, partial, or semantically wrong Handnote runs and proposing the smallest evidence-backed fix; do not use to invoke a model or modify run artifacts.
---

# Debug a Handnote run

Work read-only. Never invoke a Provider, make a paid model call, edit the run directory, retry the run, or expose a credential recovered from local files.

Start with `run.json` and check `formatVersion`. For version 1, resolve artifact references relative to the run directory: input is under `input/`, every revision has Markdown/HTML/PNG under `intermediate/revisions/NNNN/`, and only complete runs have `output/note.md` and `output/note.png`. A partial result lives in the indexed current revision. Revision files and captured assets always survive cleanup; only `intermediate/inspections/` may be absent when `saveIntermediateImages=false`.

Use `currentRevision`, `reviewedRevision` and `final` from the manifest as the committed state. Verify each artifact against its `{path,sha256}` reference, including revision HTML/PNG and referenced figures. Final Markdown and PNG hashes must equal the corresponding reviewed revision hashes. `note.md` uses `../assets/figures/...` relative to the final `output/note.md`; Handnote uses that same document base to rebuild historical revisions.

Version 1 managed paths and image references must not contain symbolic links below the run root, including links to another location within the same run. Inspect links without following them; report them as filesystem corruption. Cross-check the Markdown's actual resource references against the revision index: an intact link target listed in the manifest does not prove the original image reference still works.

For a complete run, locate the `note.finalized` event by `manifest.final.eventSeq`, then locate the revision’s `document.revision.committed` event by its `commitEventSeq`. Read uncertainties and conservative corrections from `data.audit` on that exact event. Success-shaped events and directories without manifest confirmation can be leftovers from interrupted transactions; do not select the last success event or highest directory number as authoritative. Report unconfirmed directories and an incomplete session tail as recovery evidence, without deleting files or opening the store in recovery/write mode.

Determine the audit contract used when the run was generated from its recorded prompt/configuration and available code revision. Current targets match exact, case-sensitive Markdown source substrings; preserve all whitespace and markers, count overlapping matches, and select the 1-based `occurrence` (default 1). A matching quote does not prove visual presence: use `note.png` or a retained render to check whether the selected content was actually displayed and faithful to the source. A missing visual target with matching source and hashes is a visual review failure, not filesystem corruption.

Unversioned historical runs retain their old paths and manifest shapes; inspect their recorded references rather than imposing the version 1 layout. Historical runs may also use rendered-visible-text locators. Interpret those with their original contract: formatting, entities, Mermaid labels and math can differ from Markdown syntax. Do not impose current source matching on those runs, rewrite their files, or migrate their audits. If the contract cannot be established, state that uncertainty. In all runs, audit metadata stays session-only; selected readings appear as ordinary note content, without an audit appendix or observer commentary.

Build a chronological evidence chain from monotonic event `seq` values. Distinguish model steps from `model.attempt.*` transport retries. Cite the smallest relevant set of event sequence numbers and paths.

For version 1, a missing or empty session log, or one without its initial `run.created` event, is corruption. Preserve the manifest's recorded usage in the diagnosis; missing evidence does not mean zero usage. Recovery validates paths and artifacts before modifying files. Only an incomplete tail after valid events can be repaired. Manifest free text and audit text are redacted, while manifest integrity fields and the hashes in its referenced revision/review/finalize events remain exact; a short credential substring coincidentally appearing in a hash is not itself evidence of a leaked credential.

Classify the primary cause as one of:

- preflight/configuration;
- authentication;
- transient Provider exhaustion;
- image, tool-calling, or tool-result-media incompatibility;
- markdown or audit validation (`invalid_markdown` issues, quote-locator failures);
- rendering or blocking layout;
- model protocol/step-budget behavior;
- filesystem or internal consistency (including finalize hash mismatch when the on-disk revision file no longer matches the reviewed revision).

Check for a secondary failure only when it materially changed the terminal status. A `partial` result is expected when a valid revision exists but finalization did not succeed; `complete` requires a manifest-confirmed `note.finalized` event. For finalization failures, compare the revision's render step, later review step, finalization step, mutation history, blocking warnings, and the on-disk revision and asset hashes.

Report the observed status and primary cause, the evidence chain, and one minimal repair suggestion. Separate facts from inference. If evidence is insufficient, name the exact missing artifact or event instead of guessing.
