import type { ModelMediaOptions } from "../image.ts";
import type { SessionRecorder } from "../session.ts";

import type { RunStore } from "../store.ts";

export interface ToolContext {
  store: RunStore;
  sourcePath: string;
  width: number;
  maxSteps: number;
  maxInspectCalls: number;
  toolMedia: ModelMediaOptions;
  recorder: SessionRecorder;
}
