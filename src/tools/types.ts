import type { ModelMediaOptions } from "../image.ts";
import type { SessionRecorder } from "../session.ts";
import type { RunState } from "../state.ts";

export interface ToolContext {
  sourcePath: string;
  runDirectory: string;
  width: number;
  maxSteps: number;
  maxInspectCalls: number;
  toolMedia: ModelMediaOptions;
  state: RunState;
  recorder: SessionRecorder;
}
