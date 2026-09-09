export { RenderError } from "./errors.ts";
export type {
  InkReplacement,
  InkReplacementResult,
  InkSourceSpacing,
} from "./ink-renderer.ts";
export { InkReplacementError, renderPreparedDocument } from "./ink-renderer.ts";
export type {
  CompiledNote,
  ImageResolver,
  ImageResource,
  MarkdownIssue,
} from "./markdown.ts";
export {
  compileNoteMarkdown,
  ImageResourceError,
  MarkdownValidationError,
  maxMarkdownLength,
} from "./markdown.ts";
export type {
  DocumentTarget,
  PreparedDocument,
  TextRange,
} from "./prepared.ts";
export {
  prepareDocument,
  TargetValidationError,
  validateTargets,
} from "./prepared.ts";
export type { LayoutWarning, NoteStructure } from "./render-metadata.ts";
export { layoutWarningSchema, noteStructureSchema } from "./render-metadata.ts";
export type { RenderResult } from "./renderer.ts";
export { isAllowedRenderRequest, renderDocument } from "./renderer.ts";
