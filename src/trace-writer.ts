import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatError } from "./utils.js";

export const TRACE_DIR_ENV = "PI_AC_TRACE_DIR";

/**
 * Resolves the single directory every trace is written to.
 *
 * Deliberately *not* derived from Pi's agent dir: that one is relocated per project via
 * `PI_CODING_AGENT_DIR`, which scatters the dataset across every checkout and makes the
 * traces useless as a corpus. `~/.pi/ac-traces` is one place per machine, and each record
 * carries its own `session.cwd` so per-project slicing is still possible after the fact.
 */
export function getTraceDir(): string {
  const configured = process.env[TRACE_DIR_ENV]?.trim();
  if (configured) return path.resolve(expandHome(configured));
  return path.join(os.homedir(), ".pi", "ac-traces");
}

function expandHome(target: string): string {
  if (target === "~") return os.homedir();
  if (target.startsWith("~/")) return path.join(os.homedir(), target.slice(2));
  return target;
}

/** Local `YYYY-MM-DD`; day boundaries follow the machine's clock, not UTC. */
export function formatTraceDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function getDailyTraceFile(dir: string, prefix: string, now = new Date()): string {
  return path.join(dir, `${prefix}-${formatTraceDate(now)}.jsonl`);
}

/**
 * Append-only writer for a daily JSONL file.
 *
 * Writes are synchronous and batched: a completion record is only written once its
 * outcome is known, so this never runs on the keystroke path, and a synchronous append
 * means a hard exit cannot lose the day's data the way a buffered stream would.
 *
 * Tracing must never break editor input, so every failure is swallowed and surfaced
 * through `error` instead (see `/ac trace`).
 */
export class JsonlTraceWriter {
  private ensuredDir: string | null = null;
  private lastError: string | null = null;
  private written = 0;

  constructor(
    private readonly dir: string,
    private readonly prefix: string,
  ) {}

  get directory(): string {
    return this.dir;
  }

  get error(): string | null {
    return this.lastError;
  }

  get recordsWritten(): number {
    return this.written;
  }

  currentFile(now = new Date()): string {
    return getDailyTraceFile(this.dir, this.prefix, now);
  }

  write(record: unknown): void {
    this.writeAll([record]);
  }

  writeAll(records: readonly unknown[]): void {
    if (records.length === 0) return;

    const lines: string[] = [];
    for (const record of records) {
      const line = serializeRecord(record);
      if (line) lines.push(line);
    }
    if (lines.length === 0) return;

    try {
      const filePath = this.currentFile();
      const dir = path.dirname(filePath);
      if (this.ensuredDir !== dir) {
        fs.mkdirSync(dir, { recursive: true });
        this.ensuredDir = dir;
      }
      fs.appendFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
      this.written += lines.length;
      this.lastError = null;
    } catch (error) {
      this.lastError = formatError(error);
    }
  }
}

function serializeRecord(record: unknown): string | null {
  try {
    return JSON.stringify(record, safeJsonReplacer);
  } catch {
    return null;
  }
}

export function safeJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export type TraceFileSummary = {
  file: string;
  exists: boolean;
  bytes: number;
  records: number;
  completions: number;
  shown: number;
  accepted: number;
  filtered: number;
  stale: number;
  errors: number;
  submissions: number;
  acceptedChars: number;
};

/**
 * Reads back one day file for `/ac trace`. Parsing is best-effort: a half-written last
 * line (or a record from a future schema) is skipped rather than reported as an error.
 */
export function summarizeTraceFile(filePath: string): TraceFileSummary {
  const summary: TraceFileSummary = {
    file: filePath,
    exists: false,
    bytes: 0,
    records: 0,
    completions: 0,
    shown: 0,
    accepted: 0,
    filtered: 0,
    stale: 0,
    errors: 0,
    submissions: 0,
    acceptedChars: 0,
  };

  let content: string;
  try {
    const stats = fs.statSync(filePath);
    summary.exists = true;
    summary.bytes = stats.size;
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return summary;
  }

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;

    let record: {
      type?: unknown;
      outcome?: { status?: unknown; shown?: unknown; accepted_chars?: unknown };
    };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }

    summary.records += 1;
    if (record.type === "submission") {
      summary.submissions += 1;
      continue;
    }
    if (record.type !== "completion") continue;

    summary.completions += 1;
    if (record.outcome?.shown === true) summary.shown += 1;
    if (typeof record.outcome?.accepted_chars === "number") {
      summary.acceptedChars += record.outcome.accepted_chars;
    }

    const status = record.outcome?.status;
    if (status === "accepted_full" || status === "accepted_partial") summary.accepted += 1;
    else if (status === "filtered") summary.filtered += 1;
    else if (status === "stale") summary.stale += 1;
    else if (status === "error") summary.errors += 1;
  }

  return summary;
}
