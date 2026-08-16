import fs from "node:fs";
import path from "node:path";
import { resolvePromptMode } from "./config.js";
import { DEBUG_FILE_PREFIX } from "./trace-schema.js";
import { getDailyTraceFile, safeJsonReplacer } from "./trace-writer.js";
import type { DebugTraceDetails, GhostConfig } from "./types.js";
import { formatError } from "./utils.js";

/**
 * Verbose event stream, written only while `/ac debug` or `PI_GHOST_DEBUG` is enabled.
 *
 * This is the debugging companion of the completion traces, not a replacement for them:
 * one line per internal event (schedule, skip, request, response, cleanup, accept), which
 * is what you want when chasing why a specific ghost did or did not appear, and far too
 * noisy to keep as a corpus. It lives in `<trace dir>/debug/` so both end up in one place.
 *
 * Buffered through a stream because it writes on the keystroke path; the completion traces
 * use synchronous appends instead. Tracing must never break editor input, so a failing
 * file is dropped rather than retried.
 */
/** Today's verbose debug file, kept next to the completion traces. */
export function getDebugTraceFile(config: GhostConfig, now = new Date()): string {
  return getDailyTraceFile(path.join(config.traceDir, "debug"), DEBUG_FILE_PREFIX, now);
}

export class DebugTraceWriter {
  private stream: fs.WriteStream | null = null;
  private streamPath: string | null = null;
  private failedPath: string | null = null;
  private seq = 0;

  constructor(
    private readonly config: GhostConfig,
    private readonly sessionId: string,
  ) {}

  /** Today's debug file. Rolls over at midnight without restarting the session. */
  get filePath(): string {
    return getDebugTraceFile(this.config);
  }

  write(message: string, details?: DebugTraceDetails): void {
    const filePath = this.filePath;
    if (this.failedPath === filePath) return;

    try {
      this.ensureStream(filePath);
      this.stream?.write(`${this.serialize(message, details)}\n`);
    } catch {
      this.failedPath = filePath;
      this.close();
    }
  }

  close(): void {
    const stream = this.stream;
    this.stream = null;
    this.streamPath = null;
    if (!stream) return;

    try {
      stream.end();
    } catch {
      // Debug tracing must never break editor input handling.
    }
  }

  private ensureStream(filePath: string): void {
    if (this.stream && this.streamPath === filePath) return;

    this.close();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const stream = fs.createWriteStream(filePath, {
      flags: "a",
      encoding: "utf8",
    });
    stream.on("error", () => {
      this.failedPath = filePath;
      this.close();
    });

    this.stream = stream;
    this.streamPath = filePath;
    if (this.failedPath !== filePath) this.failedPath = null;

    // A day file holds several sessions, so every segment opens with the config that
    // produced the events after it.
    stream.write(`${this.serialize("debug: trace file opened", this.getOpenDetails())}\n`);
  }

  private getOpenDetails(): DebugTraceDetails {
    return {
      event: "debug-open",
      model: this.config.model,
      promptMode: this.config.promptMode,
      resolvedPromptMode: resolvePromptMode(this.config),
      ollamaUrl: this.config.ollamaUrl,
      keepAlive: this.config.keepAlive,
      debounceMs: this.config.debounceMs,
      timeoutMs: this.config.timeoutMs,
      checkTimeoutMs: this.config.checkTimeoutMs,
      doubleTabMs: this.config.doubleTabMs,
      minChars: this.config.minChars,
      maxTokens: this.config.maxTokens,
      inline: this.config.inline,
      trace: this.config.trace,
      traceDir: this.config.traceDir,
    };
  }

  private serialize(message: string, details?: DebugTraceDetails): string {
    this.seq += 1;
    const { fileOnly: _fileOnly, event, ...rest } = details ?? {};
    const record = {
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      seq: this.seq,
      event: typeof event === "string" ? event : "debug",
      msg: message,
      ...rest,
    };

    try {
      return JSON.stringify(record, safeJsonReplacer);
    } catch (error) {
      return JSON.stringify({
        ts: record.ts,
        session_id: record.session_id,
        seq: record.seq,
        event: record.event,
        msg: message,
        error: `Serialization failed: ${formatError(error)}`,
      });
    }
  }
}
