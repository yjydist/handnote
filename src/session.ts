import { appendFileSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { dirname, relative } from "node:path";
import { HandnoteError } from "./errors.ts";
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

export function readSession(path: string): {
  events: SessionEvent[];
  completeBytes: number;
  trailingBytes: number;
} {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { events: [], completeBytes: 0, trailingBytes: 0 };
    throw error;
  }
  const completeBytes = bytes.lastIndexOf(10) + 1;
  const text = bytes.subarray(0, completeBytes).toString("utf8");
  const events: SessionEvent[] = [];
  for (const line of text ? text.slice(0, -1).split("\n") : []) {
    let event: SessionEvent;
    try {
      event = JSON.parse(line);
    } catch {
      throw new HandnoteError("Invalid session event JSON", "filesystem");
    }
    if (
      !event ||
      typeof event !== "object" ||
      event.seq !== events.length + 1 ||
      typeof event.type !== "string" ||
      typeof event.time !== "string"
    )
      throw new HandnoteError(
        "Invalid session event sequence or shape",
        "filesystem",
      );
    events.push(event);
  }
  return { events, completeBytes, trailingBytes: bytes.length - completeBytes };
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
    const existing = readSession(this.path);
    this.#seq = existing.events.at(-1)?.seq ?? 0;
    if (existing.trailingBytes) {
      truncateSync(this.path, existing.completeBytes);
      this.record("session.tail.recovered", {
        discardedBytes: existing.trailingBytes,
      });
    }
  }

  sanitize<T>(value: T): T {
    return redactValue(value, "", this.#redactionContext) as T;
  }

  record(type: string, data: unknown = {}): SessionEvent {
    const event = {
      seq: this.#seq + 1,
      time: isoWithOffset(),
      type,
      data: redactValue(data, "", this.#redactionContext),
    };
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      flush: true,
    });
    this.#seq = event.seq;
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
