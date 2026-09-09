import type { InkBinding } from "@handnote/app/ink-matching";
import type { AssociatedInkCandidate } from "@handnote/ink";

export interface SourceRun {
  readonly bindings: InkBinding[];
  readonly candidates: AssociatedInkCandidate[];
}

export function groupSourceRuns(
  bindings: readonly InkBinding[],
  candidates: readonly AssociatedInkCandidate[],
  options: { mode?: "whole-run" | "overlapping-images" } = {},
): SourceRun[] {
  const byId = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  const runs: SourceRun[] = [];
  for (const binding of bindings) {
    const candidate = byId.get(binding.sourceId);
    if (!candidate)
      throw new Error(`Unknown ink source in binding: ${binding.sourceId}`);
    let run = { bindings: [binding], candidates: [candidate] };
    while (runs.length > 0) {
      const previous = runs.at(-1);
      if (!previous || !sourceRunsAreContiguous(previous, run)) break;
      if (
        options.mode === "overlapping-images" &&
        renderedRunBounds(run.candidates).left >=
          renderedRunBounds(previous.candidates).right
      )
        break;
      previous.bindings.push(...run.bindings);
      previous.candidates.push(...run.candidates);
      runs.pop();
      run = previous;
    }
    runs.push(run);
  }
  return runs;
}

function sourceRunsAreContiguous(previous: SourceRun, next: SourceRun) {
  const previousBinding = previous.bindings.at(-1);
  const previousCandidate = previous.candidates.at(-1);
  const binding = next.bindings[0];
  const candidate = next.candidates[0];
  return (
    previousBinding &&
    previousCandidate &&
    binding &&
    candidate &&
    previousBinding.target.documentHash === binding.target.documentHash &&
    previousBinding.target.rangeId === binding.target.rangeId &&
    previousBinding.target.end === binding.target.start &&
    previousCandidate.sourceHash === candidate.sourceHash &&
    previousCandidate.lineId === candidate.lineId &&
    previousCandidate.occurrence.end === candidate.occurrence.start
  );
}

function renderedRunBounds(candidates: readonly AssociatedInkCandidate[]) {
  let minX = Number.POSITIVE_INFINITY;
  let maxRight = Number.NEGATIVE_INFINITY;
  for (const { bounds } of candidates) {
    minX = Math.min(minX, bounds.x);
    maxRight = Math.max(maxRight, bounds.x + bounds.width);
  }
  return { left: minX, right: minX + Math.ceil(maxRight - minX) };
}
