import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { EXTENSION_VERSION, TRACE_TOOL_NAME } from "./constants.js";
import type { OllamaGenerateRequest } from "./ollama.js";
import {
  AC_TRACE_SCHEMA,
  MAX_PREFIX_CHARS,
  MAX_PROMPT_CHARS,
  MAX_RAW_CHARS,
  MAX_SUBMISSION_CHARS,
  MAX_TYPED_CHARS,
  TRACE_FILE_PREFIX,
  type CompletionStatus,
  type CompletionTraceRecord,
  type SubmissionTraceRecord,
  type TraceMatch,
  type TraceOllamaMetrics,
  type TraceSessionInfo,
  type TraceToolInfo,
  type TypedSource,
} from "./trace-schema.js";
import { JsonlTraceWriter } from "./trace-writer.js";
import type { AutocompleteConfig, PromptMode, ResolvedPromptMode } from "./types.js";

/** Pending suggestions still waiting for an outcome, per editor. */
const MAX_PENDING = 32;
/** A suggestion nobody ever resolved is flushed rather than kept forever. */
const PENDING_TTL_MS = 5 * 60_000;
/**
 * How far past the end of a suggestion the user has to type before the outcome is
 * considered settled. The comparison only ever looks at the first `suggestion.length`
 * characters, so a small margin is enough - it just avoids finalizing mid-word.
 */
const TYPED_MARGIN_CHARS = 16;

export type EditorContextSnapshot = {
  line: number | null;
  col: number | null;
  lines: number;
  trigger: string;
};

export function emptyContextSnapshot(): EditorContextSnapshot {
  return { line: null, col: null, lines: 1, trigger: "" };
}

/** What the prediction pipeline knows about a request by the time it ends. */
export type CompletionOutcomeHint = "shown" | "filtered" | "stale" | "error";

export type CompletionTraceDraft = {
  requestId: number;
  hint: CompletionOutcomeHint;
  /** Why it was not shown (`stale`, `chat-like`, ...). */
  reason: string | null;
  prefix: string;
  suffix: string;
  context: EditorContextSnapshot;
  model: string;
  promptMode: PromptMode;
  resolvedPromptMode: ResolvedPromptMode;
  request: OllamaGenerateRequest | null;
  raw: string | null;
  completion: string | null;
  rejectReason: string | null;
  metrics: Record<string, unknown> | null;
  scheduledAt: number;
  startedAt: number | null;
  finishedAt: number;
  requestMs: number | null;
  debounceMs: number;
  error: { message: string; timedOut: boolean; aborted: boolean } | null;
};

/**
 * Owns the trace file and the session identity shared by every record.
 *
 * One instance per loaded extension; the per-editor lifecycle lives in
 * `CompletionTraceTracker`.
 */
export class TraceRecorder {
  readonly sessionId = randomUUID();
  private readonly cwd = process.cwd();
  private seq = 0;
  private writer: JsonlTraceWriter | null = null;
  private writerDir: string | null = null;

  constructor(private readonly config: AutocompleteConfig) {}

  get enabled(): boolean {
    return this.config.trace;
  }

  get directory(): string {
    return this.config.traceDir;
  }

  get lastError(): string | null {
    return this.writer?.error ?? null;
  }

  currentFile(now = new Date()): string {
    return this.getWriter().currentFile(now);
  }

  write(records: ReadonlyArray<CompletionTraceRecord | SubmissionTraceRecord>): void {
    if (!this.enabled || records.length === 0) return;
    this.getWriter().writeAll(records);
  }

  nextSession(): TraceSessionInfo {
    this.seq += 1;
    return {
      id: this.sessionId,
      seq: this.seq,
      cwd: this.cwd,
      project: path.basename(this.cwd),
    };
  }

  tool(): TraceToolInfo {
    return { name: TRACE_TOOL_NAME, version: EXTENSION_VERSION };
  }

  private getWriter(): JsonlTraceWriter {
    // The directory can change under us when the config is reloaded on session start.
    if (!this.writer || this.writerDir !== this.config.traceDir) {
      this.writer = new JsonlTraceWriter(this.config.traceDir, TRACE_FILE_PREFIX);
      this.writerDir = this.config.traceDir;
    }
    return this.writer;
  }
}

type PendingCompletion = {
  record: CompletionTraceRecord;
  /** Untruncated prefix, needed to recognise the continuation in later editor text. */
  prefix: string;
  suggestion: string;
  hint: CompletionOutcomeHint;
  reason: string | null;
  createdAt: number;
  shownAt: number | null;
  acceptedChars: number;
  acceptEvents: number;
  fullyAccepted: boolean;
  typed: string;
  diverged: boolean;
  resolved: boolean;
};

type CompositionStats = {
  requests: number;
  shown: number;
  accepted: number;
  filtered: number;
  stale: number;
  errors: number;
  acceptedChars: number;
};

/**
 * Turns completion requests into finished trace records.
 *
 * A request is only half a trace: the interesting half is what the user did next. Records
 * are therefore held open until the answer is known - the suggestion was accepted, enough
 * text was typed past it to compare against, or the prompt was submitted (which yields the
 * strongest ground truth, since the submitted text is what the completion should have
 * predicted). One tracker per editor instance.
 */
export class CompletionTraceTracker {
  private pending: PendingCompletion[] = [];
  private active: PendingCompletion | null = null;
  private stats = emptyStats();

  constructor(private readonly recorder: TraceRecorder) {}

  /** A suggestion that reached the screen as autocomplete text. */
  recordShown(draft: CompletionTraceDraft, suggestion: string): void {
    const entry = this.push(draft, suggestion);
    if (!entry) return;

    entry.shownAt = draft.finishedAt;
    this.stats.shown += 1;
    this.active = entry;
  }

  /** A request that never reached the screen: filtered, stale, or failed. */
  recordUnshown(draft: CompletionTraceDraft): void {
    const entry = this.push(draft, draft.completion ?? "");
    if (!entry) return;

    if (draft.hint === "filtered") this.stats.filtered += 1;
    else if (draft.hint === "stale") this.stats.stale += 1;
    else if (draft.hint === "error") this.stats.errors += 1;

    // A failed request has nothing to compare against, so it settles immediately.
    // Filtered and stale answers do: knowing the user typed the text we refused to show
    // is exactly the signal that improves the cleanup rules and the prompt.
    if (draft.hint === "error") this.finalize(entry, "none");
  }

  /** Tab accepted `taken` from the visible autocomplete, leaving `rest` of it on screen. */
  noteAccept(taken: string, rest: string): void {
    const entry = this.active;
    if (!entry) return;

    entry.acceptedChars += taken.length;
    entry.acceptEvents += 1;
    this.stats.acceptedChars += taken.length;
    if (entry.acceptEvents === 1) this.stats.accepted += 1;

    if (rest.length === 0) {
      entry.fullyAccepted = true;
      entry.reason = "accepted";
      this.active = null;
      this.finalize(entry, "accept");
    }
  }

  /** The visible autocomplete went away without being fully accepted. */
  noteDismiss(reason: string): void {
    const entry = this.active;
    this.active = null;
    if (!entry || entry.resolved) return;
    entry.reason = entry.reason ?? reason;
  }

  /** Current editor text; grows the observed continuation of every pending prefix. */
  noteText(text: string): void {
    if (this.pending.length === 0) return;

    for (const entry of this.pending) {
      this.observe(entry, text);
    }
    this.sweep();
  }

  /** The prompt was sent: the submitted text is the ground truth for every open record. */
  noteSubmit(text: string): void {
    const hadRequests = this.stats.requests > 0;
    for (const entry of this.pending) this.observe(entry, text);
    this.active = null;
    this.finalizeAll("submit");

    if (hadRequests) this.writeSubmission(text);
    this.stats = emptyStats();
  }

  /** Editor or session went away; write out whatever was learned. */
  flush(reason: string): void {
    this.active = null;
    for (const entry of this.pending) {
      entry.reason = entry.reason ?? reason;
    }
    this.finalizeAll("flush");
    this.stats = emptyStats();
  }

  private push(
    draft: CompletionTraceDraft,
    suggestion: string,
  ): PendingCompletion | null {
    if (!this.recorder.enabled) return null;

    this.stats.requests += 1;
    // The previous autocomplete is gone as soon as a new answer lands.
    if (this.active) {
      this.active.reason = this.active.reason ?? "superseded";
      this.active = null;
    }

    const entry: PendingCompletion = {
      record: this.buildRecord(draft),
      prefix: draft.prefix,
      suggestion,
      hint: draft.hint,
      reason: draft.reason,
      createdAt: draft.finishedAt,
      shownAt: null,
      acceptedChars: 0,
      acceptEvents: 0,
      fullyAccepted: false,
      typed: "",
      diverged: false,
      resolved: false,
    };

    this.pending.push(entry);
    while (this.pending.length > MAX_PENDING) {
      const oldest = this.pending[0];
      oldest.reason = oldest.reason ?? "evicted";
      this.finalize(oldest, oldest.typed ? "typing" : "none");
    }

    return entry;
  }

  private observe(entry: PendingCompletion, text: string): void {
    if (entry.resolved) return;

    if (text.startsWith(entry.prefix)) {
      entry.typed = text.slice(entry.prefix.length);
      return;
    }
    // The user edited back into the prefix, so the continuation no longer lines up.
    // Whatever was typed before that still describes what they wanted.
    entry.diverged = true;
  }

  private sweep(): void {
    const now = Date.now();

    for (const entry of [...this.pending]) {
      if (entry.resolved || entry === this.active) continue;

      if (entry.typed.length >= entry.suggestion.length + TYPED_MARGIN_CHARS) {
        this.finalize(entry, "typing");
        continue;
      }
      if (now - entry.createdAt > PENDING_TTL_MS) {
        entry.reason = entry.reason ?? "expired";
        this.finalize(entry, entry.typed ? "typing" : "none");
      }
    }
  }

  private finalizeAll(source: TypedSource): void {
    for (const entry of [...this.pending]) {
      this.finalize(entry, entry.typed ? source : "none");
    }
    this.pending = [];
  }

  private finalize(entry: PendingCompletion, source: TypedSource): void {
    if (entry.resolved) return;
    entry.resolved = true;
    this.pending = this.pending.filter((candidate) => candidate !== entry);
    if (this.active === entry) this.active = null;

    const acceptedText = entry.suggestion.slice(0, entry.acceptedChars);
    const typed = clip(entry.typed, MAX_TYPED_CHARS, "head");

    entry.record.outcome = {
      status: resolveStatus(entry),
      shown: entry.shownAt !== null,
      reason: entry.reason,
      accepted_chars: entry.acceptedChars,
      accepted_text: acceptedText,
      accept_events: entry.acceptEvents,
      typed_text: typed.text,
      typed_len: entry.typed.length,
      typed_truncated: typed.truncated,
      typed_source: entry.typed ? source : "none",
      diverged: entry.diverged,
      decision_ms: entry.shownAt === null ? null : Math.max(0, Date.now() - entry.shownAt),
      match: buildMatch(entry.suggestion, entry.typed),
    };

    this.recorder.write([entry.record]);
  }

  private writeSubmission(text: string): void {
    const clipped = clip(text, MAX_SUBMISSION_CHARS, "head");
    const record: SubmissionTraceRecord = {
      schema: AC_TRACE_SCHEMA,
      type: "submission",
      id: randomUUID(),
      ts: new Date().toISOString(),
      session: this.recorder.nextSession(),
      tool: this.recorder.tool(),
      text: clipped.text,
      chars: text.length,
      lines: text.split("\n").length,
      truncated: clipped.truncated,
      stats: {
        requests: this.stats.requests,
        shown: this.stats.shown,
        accepted: this.stats.accepted,
        filtered: this.stats.filtered,
        stale: this.stats.stale,
        errors: this.stats.errors,
        accepted_chars: this.stats.acceptedChars,
        accepted_ratio: text.length > 0 ? round(this.stats.acceptedChars / text.length, 4) : 0,
      },
    };

    this.recorder.write([record]);
  }

  private buildRecord(draft: CompletionTraceDraft): CompletionTraceRecord {
    const prefix = clip(draft.prefix, MAX_PREFIX_CHARS, "tail");
    const suffix = clip(draft.suffix, MAX_PREFIX_CHARS, "head");
    const request = draft.request;
    const raw = draft.raw === null ? null : clip(draft.raw, MAX_RAW_CHARS, "head");
    const completion = draft.completion ?? "";

    return {
      schema: AC_TRACE_SCHEMA,
      type: "completion",
      id: randomUUID(),
      ts: new Date(draft.scheduledAt).toISOString(),
      session: this.recorder.nextSession(),
      tool: this.recorder.tool(),
      request_id: draft.requestId,
      model: {
        id: `ollama/${draft.model}`,
        provider: "ollama",
        name: draft.model,
        prompt_mode: draft.resolvedPromptMode,
        prompt_mode_setting: draft.promptMode,
        raw: request?.raw ?? false,
        options: request?.options ?? null,
      },
      context: {
        prefix: prefix.text,
        prefix_len: draft.prefix.length,
        prefix_truncated: prefix.truncated,
        suffix: suffix.text,
        suffix_len: draft.suffix.length,
        word_prefix: wordPrefix(draft.prefix),
        at_word_boundary: /\s$/.test(draft.prefix) || draft.prefix.length === 0,
        line: draft.context.line,
        col: draft.context.col,
        lines: draft.context.lines,
        trigger: draft.context.trigger,
      },
      prompt: request ? buildPromptInfo(request.prompt) : null,
      response:
        raw === null
          ? null
          : {
              raw: raw.text,
              raw_len: draft.raw?.length ?? 0,
              completion,
              completion_len: completion.length,
              reject_reason: draft.rejectReason,
              cleaned: draft.raw !== completion,
              done_reason: readString(draft.metrics, "done_reason"),
            },
      timing: {
        debounce_ms: draft.debounceMs,
        wait_ms: Math.max(0, (draft.startedAt ?? draft.finishedAt) - draft.scheduledAt),
        request_ms: draft.requestMs,
        total_ms: Math.max(0, draft.finishedAt - draft.scheduledAt),
        ollama: buildOllamaMetrics(draft.metrics),
      },
      // Replaced wholesale by `finalize`; a record is never written before then.
      outcome: {
        status: "stale",
        shown: false,
        reason: draft.reason,
        accepted_chars: 0,
        accepted_text: "",
        accept_events: 0,
        typed_text: "",
        typed_len: 0,
        typed_truncated: false,
        typed_source: "none",
        diverged: false,
        decision_ms: null,
        match: null,
      },
      error: draft.error
        ? {
            message: draft.error.message,
            timed_out: draft.error.timedOut,
            aborted: draft.error.aborted,
          }
        : null,
    };
  }
}

function emptyStats(): CompositionStats {
  return {
    requests: 0,
    shown: 0,
    accepted: 0,
    filtered: 0,
    stale: 0,
    errors: 0,
    acceptedChars: 0,
  };
}

function resolveStatus(entry: PendingCompletion): CompletionStatus {
  if (entry.hint === "error") return "error";
  if (entry.hint === "filtered") return "filtered";
  if (entry.hint === "stale") return "stale";
  if (entry.fullyAccepted) return "accepted_full";
  if (entry.acceptedChars > 0) return "accepted_partial";
  return "shown_rejected";
}

export function buildMatch(suggestion: string, typed: string): TraceMatch | null {
  if (!suggestion || !typed) return null;

  const common = commonPrefixLength(suggestion, typed);
  const normalizedCommon = commonPrefixLength(normalize(suggestion), normalize(typed));
  const normalizedLength = normalize(suggestion).length;

  return {
    common_prefix_chars: common,
    common_prefix_ratio: round(common / suggestion.length, 4),
    typed_starts_with_suggestion: typed.startsWith(suggestion),
    common_prefix_ratio_normalized:
      normalizedLength > 0 ? round(normalizedCommon / normalizedLength, 4) : 0,
  };
}

export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index += 1;
  return index;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function wordPrefix(prefix: string): string {
  return prefix.match(/(\S+)$/)?.[1] ?? "";
}

function buildPromptInfo(prompt: string) {
  const clipped = clip(prompt, MAX_PROMPT_CHARS, "head");
  return {
    text: clipped.text,
    chars: prompt.length,
    hash: `sha256:${createHash("sha256").update(prompt).digest("hex").slice(0, 12)}`,
    truncated: clipped.truncated,
  };
}

function buildOllamaMetrics(
  metrics: Record<string, unknown> | null,
): TraceOllamaMetrics | null {
  if (!metrics) return null;

  const evalMs = readNumber(metrics, "evalMs");
  const evalTokens = readNumber(metrics, "eval_count");
  const tokensPerSecond =
    evalMs !== null && evalMs > 0 && evalTokens !== null
      ? round(evalTokens / (evalMs / 1000), 2)
      : null;

  return {
    total_ms: readNumber(metrics, "totalMs"),
    load_ms: readNumber(metrics, "loadMs"),
    prompt_ms: readNumber(metrics, "promptEvalMs"),
    prompt_tokens: readNumber(metrics, "prompt_eval_count"),
    eval_ms: evalMs,
    eval_tokens: evalTokens,
    tokens_per_second: tokensPerSecond,
  };
}

function readNumber(source: Record<string, unknown> | null, key: string): number | null {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" ? value : null;
}

/** Keeps the `head` or the `tail` of an oversized string and flags the truncation. */
export function clip(
  text: string,
  max: number,
  keep: "head" | "tail",
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: keep === "head" ? text.slice(0, max) : text.slice(-max),
    truncated: true,
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
