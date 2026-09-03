import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, relative } from "node:path";
import {
  type RedactionContext,
  type RedactionOptions,
  redactionContext,
  redactValue,
} from "./redact.ts";
import { isoWithOffset, sha256File } from "./utils.ts";

export interface SessionEvent {
  seq: number;
  time: string;
  type: string;
  data: unknown;
}

export class SessionRecorder {
  readonly path: string;
  readonly runDirectory: string;
  #seq = 0;
  readonly #redactionContext: RedactionContext;

  constructor(runDirectory: string, options: RedactionOptions = {}) {
    this.runDirectory = runDirectory;
    this.path = `${runDirectory}/session/events.jsonl`;
    this.#redactionContext = redactionContext(options);
    mkdirSync(dirname(this.path), { recursive: true });
  }

  record(type: string, data: unknown = {}): SessionEvent {
    const event = {
      seq: ++this.#seq,
      time: isoWithOffset(),
      type,
      data: redactValue(data, "", this.#redactionContext),
    };
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      flush: true,
    });
    return event;
  }

  async media(
    path: string,
    mimeType: string,
    retained = true,
  ): Promise<{
    path: string;
    mimeType: string;
    sha256: string;
    retained: boolean;
  }> {
    return {
      path: relative(this.runDirectory, path),
      mimeType,
      sha256: await sha256File(path),
      retained,
    };
  }
}
