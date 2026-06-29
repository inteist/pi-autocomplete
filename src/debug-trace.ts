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
    return this.streamPath || this.config.debugTraceFile;
  }

  write(message: string, details?: DebugTraceDetails): void {
    if (!this.streamPath) {
      this.streamPath = this.getStampedPath(this.config.debugTraceFile);
    }
    const filePath = this.streamPath;
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

  private getStampedPath(basePath: string): string {
    const dir = path.dirname(basePath);
    const ext = path.extname(basePath);
    const base = path.basename(basePath, ext);

    const now = new Date();
    const pad = (n: number, width = 2) => String(n).padStart(width, "0");
    const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
    const timestamp = `${dateStr}-${timeStr}`;

    return path.join(dir, `${base}-${timestamp}.md`);
  }

  private ensureStream(filePath: string): void {
    if (this.stream && this.streamPath === filePath) return;

    this.close();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const exists = fs.existsSync(filePath);

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

    if (!exists) {
      const frontmatter = this.getFrontmatter();
      stream.write(frontmatter);
    }
  }

  private getFrontmatter(): string {
    const lines = [
      "---",
      `model: ${this.config.model}`,
      `promptMode: ${this.config.promptMode}`,
      `resolvedPromptMode: ${resolvePromptMode(this.config)}`,
      `ollamaUrl: ${this.config.ollamaUrl}`,
      `keepAlive: ${this.config.keepAlive}`,
      `debounceMs: ${this.config.debounceMs}`,
      `timeoutMs: ${this.config.timeoutMs}`,
      `checkTimeoutMs: ${this.config.checkTimeoutMs}`,
      `doubleTabMs: ${this.config.doubleTabMs}`,
      `minChars: ${this.config.minChars}`,
      `maxTokens: ${this.config.maxTokens}`,
      `inline: ${this.config.inline}`,
      "---",
      "",
      "",
    ];
    return lines.join("\n");
  }

  private serialize(message: string, details?: DebugTraceDetails): string {
    const time = new Date().toLocaleTimeString();
    let line = `[${time}] ${message}`;

    const cleanDetails = sanitizeDetails(details);
    if (cleanDetails && Object.keys(cleanDetails).length > 0) {
      try {
        const jsonDetails = JSON.stringify(cleanDetails, safeTraceJsonReplacer);
        line += ` ${jsonDetails}`;
      } catch (error) {
        line += ` { "error": "Serialization failed: ${formatError(error)}" }`;
      }
    }
    return line;
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
