import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { RevisionAudit } from "./document.ts";
import { HandnoteError } from "./errors.ts";
import {
  type RedactionContext,
  type RedactionOptions,
  redactionContext,
  redactValue,
} from "./redact.ts";
import { checkedRunPath } from "./run-path.ts";
import { isoWithOffset, sha256File } from "./utils.ts";

export interface SessionEvent {
  seq: number;
  time: string;
  type: string;
  data: unknown;
}

type RevisionEvent = {
  revision: number;
  markdownSha256: string;
  imageSha256: string;
} & (
  | { type: "document.revision.committed"; audit: RevisionAudit }
  | { type: "render.reviewed" | "note.finalized"; step: number }
);

export function readSession(path: string): {
  events: SessionEvent[];
  completeBytes: number;
  trailingBytes: number;
} {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new HandnoteError(
      "Cannot read existing session log",
      "filesystem",
      false,
      { cause: error },
    );
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
  #appendFailure?: HandnoteError;
  readonly #redactionContext: RedactionContext;

  private constructor(runDirectory: string, options: RedactionOptions) {
    this.runDirectory = resolve(runDirectory);
    this.path = checkedRunPath(runDirectory, "session/events.jsonl", {
      kind: "file",
    });
    this.#redactionContext = redactionContext(options);
  }

  static create(
    runDirectory: string,
    options: RedactionOptions = {},
  ): SessionRecorder {
    const recorder = new SessionRecorder(runDirectory, options);
    mkdirSync(dirname(recorder.path), { recursive: true });
    writeFileSync(recorder.path, "", { flag: "wx", flush: true });
    return recorder;
  }

  static open(
    runDirectory: string,
    options: RedactionOptions = {},
  ): SessionRecorder {
    const recorder = new SessionRecorder(runDirectory, options);
    const existing = readSession(recorder.path);
    recorder.#seq = existing.events.at(-1)?.seq ?? 0;
    if (existing.trailingBytes) {
      truncateSync(recorder.path, existing.completeBytes);
      recorder.record("session.tail.recovered", {
        discardedBytes: existing.trailingBytes,
      });
    }
    return recorder;
  }

  sanitize<T>(value: T): T {
    return redactValue(value, "", this.#redactionContext) as T;
  }

  record(type: string, data: unknown = {}): SessionEvent {
    return this.append(type, this.sanitize(data));
  }

  recordRevision(event: RevisionEvent): SessionEvent {
    return this.append(event.type, {
      revision: event.revision,
      markdownSha256: event.markdownSha256,
      imageSha256: event.imageSha256,
      ...(event.type === "document.revision.committed"
        ? { audit: this.sanitize(event.audit) }
        : { step: event.step }),
    });
  }

  private append(type: string, data: unknown): SessionEvent {
    if (this.#appendFailure) throw this.#appendFailure;
    const event = {
      seq: this.#seq + 1,
      time: isoWithOffset(),
      type,
      data,
    };
    const line = `${JSON.stringify(event)}\n`;
    try {
      const path = checkedRunPath(this.runDirectory, "session/events.jsonl", {
        kind: "file",
        allowMissing: false,
      });
      appendFileSync(path, line, { encoding: "utf8", flush: true });
    } catch (error) {
      // An unsuccessful append may still have written part or all of the line.
      this.#appendFailure = new HandnoteError(
        "Session log append failed; reopen the run before writing again",
        "filesystem",
        false,
        { cause: error },
      );
      throw this.#appendFailure;
    }
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
