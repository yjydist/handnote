import type { RevisionAudit } from "./document.ts";
import type { HandnoteError } from "./errors.ts";
import type { LayoutWarning, RenderResult } from "./renderer.ts";

export interface Revision {
  number: number;
  markdown: string;
  markdownSha256: string;
  audit: RevisionAudit;
  render: RenderResult;
  renderedAtStep: number;
  reviewedAtStep?: number;
  reviewWarnings?: LayoutWarning[];
}

export class RunState {
  revision?: Revision;
  modelStep = 0;
  fatalError?: HandnoteError;
  #finalizedRevision?: number;
  #tail: Promise<void> = Promise.resolve();

  get finalized(): boolean {
    return this.#finalizedRevision !== undefined;
  }

  get finalizedRevision(): number | undefined {
    return this.#finalizedRevision;
  }

  beginModelStep(): number {
    return ++this.modelStep;
  }

  fail(error: HandnoteError): void {
    this.fatalError ??= error;
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const wait = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await wait;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  commit(
    markdown: string,
    markdownSha256: string,
    audit: RevisionAudit,
    render: RenderResult,
  ): Revision {
    if (this.finalized)
      throw new Error("Cannot commit a revision after finalization");
    this.revision = {
      number: (this.revision?.number ?? 0) + 1,
      markdown,
      markdownSha256,
      audit,
      render,
      renderedAtStep: this.modelStep,
    };
    return this.revision;
  }

  review(): Revision {
    if (this.finalized) throw new Error("Cannot review after finalization");
    if (!this.revision) throw new Error("No note revision exists");
    this.revision.reviewedAtStep = this.modelStep;
    this.revision.reviewWarnings = this.revision.render.warnings;
    return this.revision;
  }

  canFinalize():
    | { ok: true; revision: Revision }
    | { ok: false; reason: string } {
    if (this.finalized)
      return { ok: false, reason: "Run is already finalized" };
    const revision = this.revision;
    if (!revision) return { ok: false, reason: "No note revision exists" };
    if (revision.reviewedAtStep === undefined)
      return { ok: false, reason: "Current revision has not been reviewed" };
    if (revision.reviewedAtStep <= revision.renderedAtStep)
      return {
        ok: false,
        reason: "Review must occur in a later model step than rendering",
      };
    if (this.modelStep <= revision.reviewedAtStep)
      return {
        ok: false,
        reason: "Finalize must occur in a later model step than review",
      };
    if ((revision.reviewWarnings ?? []).some((warning) => warning.blocking))
      return { ok: false, reason: "Review contains blocking layout warnings" };
    return { ok: true, revision };
  }

  markFinalized(revision: Revision): void {
    if (this.revision !== revision)
      throw new Error("Cannot finalize a stale note revision");
    if (this.finalized) throw new Error("Run is already finalized");
    this.#finalizedRevision = revision.number;
  }
}
