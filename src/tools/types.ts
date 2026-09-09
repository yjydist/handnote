import type { ModelMediaOptions } from "../run/image.ts";
import type { SessionRecorder } from "../run/session.ts";

import type { RunStore } from "../run/store.ts";

export interface ToolContext {
  store: RunStore;
  sourcePath: string;
  width: number;
  maxInspectCalls: number;
  toolMedia: ModelMediaOptions;
  recorder: SessionRecorder;
}
