import {
  type CompiledNote,
  RenderError,
  type RenderResult,
  renderDocument as render,
} from "../renderer/index.ts";
import { HandnoteError } from "./errors.ts";

export type { LayoutWarning, RenderResult } from "../renderer/index.ts";
export { isAllowedRenderRequest } from "../renderer/index.ts";

export async function renderDocument(
  note: CompiledNote,
  directory: string,
): Promise<RenderResult> {
  try {
    return await render(note, directory);
  } catch (error) {
    if (error instanceof RenderError)
      throw new HandnoteError(error.message, error.kind, false, {
        cause: error.cause,
      });
    throw error;
  }
}
