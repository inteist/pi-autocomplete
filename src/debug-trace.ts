import fs from "node:fs";
import path from "node:path";
import { describePromptMode, resolvePromptMode } from "./config.js";
import type { DebugTraceDetails, GhostConfig } from "./types.js";
import { formatError } from "./utils.js";

/**
 * JSONL trace writer used only while `/ac debug` or PI_GHOST_DEBUG is enabled.
 * It appends structured traces to disk so autocomplete latency, prompt payloads,
 * model timings, cleanup, and rejection decisions can be inspected after a run.
 */
export class DebugTraceWriter {
  private stream: fs.WriteStream | null = null;
  private streamPath: string | null = null;
  private failedPath: string | null = null;

  constructor(private readonly config: GhostConfig) {}

  get filePath(): string {
    return this.config.debugTraceFile;
  }

  write(message: string, details?: DebugTraceDetails): void {
    const filePath = this.filePath;
    if (!filePath || this.failedPath === filePath) return;

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
  }

  private serialize(message: string, details?: DebugTraceDetails): string {
    const now = new Date();
    const record = {
      ts: now.toISOString(),
      epochMs: now.getTime(),
      source: "pi-ghost-vim",
      event:
        details && typeof details.event === "string"
          ? details.event
          : "debug",
      message,
      details: sanitizeDetails(details),
      config: {
        model: this.config.model,
        promptMode: this.config.promptMode,
        resolvedPromptMode: resolvePromptMode(this.config),
        promptModeDescription: describePromptMode(this.config),
        ollamaUrl: this.config.ollamaUrl,
        keepAlive: this.config.keepAlive,
        debounceMs: this.config.debounceMs,
        timeoutMs: this.config.timeoutMs,
        minChars: this.config.minChars,
        maxTokens: this.config.maxTokens,
        inline: this.config.inline,
      },
    };

    try {
      return JSON.stringify(record, safeTraceJsonReplacer);
    } catch (error) {
      return JSON.stringify({
        ts: now.toISOString(),
        epochMs: now.getTime(),
        source: "pi-ghost-vim",
        event: "trace-serialization-error",
        message,
        error: formatError(error),
      });
    }
  }
}

function sanitizeDetails(
  details: DebugTraceDetails | undefined,
): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const { fileOnly: _fileOnly, ...rest } = details;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function safeTraceJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  return value;
}
