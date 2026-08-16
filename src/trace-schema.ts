import type { PromptMode, ResolvedPromptMode } from "./types.js";

/**
 * On-disk schema for autocomplete traces.
 *
 * The shape borrows its conventions from the Agent Trace spec (https://agent-trace.dev):
 * a semver `schema` string, a UUID `id`, an RFC 3339 `ts`, a `tool` block identifying the
 * producer, and a models.dev-style `model.id` of the form `provider/model`. Everything
 * else is different on purpose - Agent Trace attributes committed *lines of code* to
 * conversations, while this records *keystroke-time completion attempts*, so there is no
 * file/range/contributor structure here at all.
 *
 * One record per line of a daily JSONL file. Two record types:
 *
 * - `completion` - one per model request, written once its outcome is known: what the
 *   user had typed, what was sent to the model, what came back, whether it was shown,
 *   whether it was accepted, and what the user ended up typing instead.
 * - `submission` - one per submitted prompt, holding the final text plus how much of it
 *   came from autocomplete. The final text is the best available ground truth for
 *   "what should the completion have been", so it is worth keeping next to the attempts.
 *
 * Records are self-contained (model and config are repeated on every line) so that a day
 * file can be analysed with `jq` or `pandas.read_json(lines=True)` without a join.
 */
export const AC_TRACE_VERSION = "0.1.0";
export const AC_TRACE_SCHEMA = `ac-trace/${AC_TRACE_VERSION}`;

/** Basename prefix of the daily completion/submission trace file. */
export const TRACE_FILE_PREFIX = "ac-trace";
/** Basename prefix of the daily verbose debug stream (`/ac debug on`). */
export const DEBUG_FILE_PREFIX = "ac-debug";

/**
 * Terminal state of a single completion request.
 *
 * - `accepted_full`    - the whole suggestion was accepted (double-Tab, or chunk by chunk).
 * - `accepted_partial` - some chunks were accepted, the rest was not.
 * - `shown_rejected`   - shown as autocomplete text and never accepted.
 * - `filtered`         - the model answered but cleanup/validation refused to show it.
 * - `stale`            - the answer arrived after the context had moved on (typing race).
 * - `error`            - the request failed, timed out, or was aborted.
 */
export type CompletionStatus =
  | "accepted_full"
  | "accepted_partial"
  | "shown_rejected"
  | "filtered"
  | "stale"
  | "error";

/** How `outcome.typed_text` was observed. */
export type TypedSource =
  /** Resolved by the accept itself - the typed text is the accepted text. */
  | "accept"
  /** Enough characters were typed after the prefix to compare against the suggestion. */
  | "typing"
  /** Resolved from the submitted prompt (the strongest ground truth). */
  | "submit"
  /** Resolved when the editor/session went away, or the entry aged out. */
  | "flush"
  /** Nothing was ever typed after the prefix. */
  | "none";

export type TraceSessionInfo = {
  /** Random per-extension-instance id, stable for the life of the Pi session. */
  id: string;
  /** Monotonic record counter within the session; restores ordering inside a day file. */
  seq: number;
  /** Where Pi was started - the traces of every project land in one file. */
  cwd: string;
  project: string;
};

export type TraceToolInfo = {
  name: string;
  version: string;
};

export type TraceModelInfo = {
  /** models.dev-style identifier, e.g. `ollama/LFM25:2.6b`. */
  id: string;
  provider: string;
  name: string;
  /** The mode actually used to build the prompt. */
  prompt_mode: ResolvedPromptMode;
  /** The configured mode, which may be `auto`. */
  prompt_mode_setting: PromptMode;
  /** Whether Ollama was asked to skip its chat template. */
  raw: boolean;
  options: {
    temperature: number;
    top_p: number;
    num_predict: number;
    num_ctx: number;
    repeat_penalty: number;
    stop: string[];
  } | null;
};

export type TraceContext = {
  /** Text left of the cursor, tail-truncated to `MAX_PREFIX_CHARS`. */
  prefix: string;
  /** True length of the prefix before truncation. */
  prefix_len: number;
  prefix_truncated: boolean;
  /** Text right of the cursor. Always empty today: predictions only run at end of buffer. */
  suffix: string;
  suffix_len: number;
  /** Unfinished word at the cursor, i.e. what a mid-word completion has to finish. */
  word_prefix: string;
  /** True when the prefix ends on whitespace, i.e. a new word is expected. */
  at_word_boundary: boolean;
  /** Cursor position when the request was scheduled, if the editor exposes it. */
  line: number | null;
  col: number | null;
  lines: number;
  /** Printable form of the keystroke that triggered the request. */
  trigger: string;
};

export type TracePromptInfo = {
  /** The exact string sent to Ollama, including few-shots and control tokens. */
  text: string;
  chars: number;
  /** `sha256:<12 hex>` of the full prompt, for grouping records by prompt template. */
  hash: string;
  truncated: boolean;
};

export type TraceResponseInfo = {
  /** Untouched model output. */
  raw: string;
  raw_len: number;
  /** Output after `cleanupCompletion`, i.e. the text that would be shown. */
  completion: string;
  completion_len: number;
  /** Why the completion was refused, e.g. `chat-like`; null when it was shown. */
  reject_reason: string | null;
  /** Whether cleanup changed the raw text at all. */
  cleaned: boolean;
  /** Ollama's stop reason, e.g. `stop` or `length` (hit `num_predict`). */
  done_reason: string | null;
};

export type TraceOllamaMetrics = {
  total_ms: number | null;
  load_ms: number | null;
  prompt_ms: number | null;
  prompt_tokens: number | null;
  eval_ms: number | null;
  eval_tokens: number | null;
  tokens_per_second: number | null;
};

export type TraceTiming = {
  debounce_ms: number;
  /** Keystroke to request start, i.e. the debounce actually served. */
  wait_ms: number;
  /** HTTP roundtrip to Ollama. */
  request_ms: number | null;
  /** Keystroke to autocomplete text on screen (or to the decision not to show it). */
  total_ms: number;
  ollama: TraceOllamaMetrics | null;
};

export type TraceMatch = {
  /** Characters the suggestion and the typed text share from the start. */
  common_prefix_chars: number;
  /** `common_prefix_chars / suggestion length`, 0..1. */
  common_prefix_ratio: number;
  /** True when the user typed the whole suggestion, whether or not they accepted it. */
  typed_starts_with_suggestion: boolean;
  /** Same comparison with case and whitespace normalised. */
  common_prefix_ratio_normalized: number;
};

export type TraceOutcome = {
  status: CompletionStatus;
  shown: boolean;
  /** Why it was not shown, or how a shown autocomplete was dismissed (`escape`, `typing`, ...). */
  reason: string | null;
  accepted_chars: number;
  /** The portion of the suggestion that made it into the buffer. */
  accepted_text: string;
  /** Number of Tab accepts applied to this suggestion. */
  accept_events: number;
  /**
   * What actually followed the prefix, including any accepted part. Compare against
   * `response.completion` to see how close the suggestion was to reality.
   */
  typed_text: string;
  typed_len: number;
  typed_truncated: boolean;
  typed_source: TypedSource;
  /** True when the user edited back into the prefix, so the comparison is partial. */
  diverged: boolean;
  /** Autocomplete shown to outcome resolved. */
  decision_ms: number | null;
  match: TraceMatch | null;
};

export type TraceError = {
  message: string;
  timed_out: boolean;
  aborted: boolean;
};

export type CompletionTraceRecord = {
  schema: string;
  type: "completion";
  id: string;
  /** RFC 3339 (UTC) of the keystroke that triggered the request. */
  ts: string;
  session: TraceSessionInfo;
  tool: TraceToolInfo;
  /** Per-session request counter, matching the `#N` in the debug stream. */
  request_id: number;
  model: TraceModelInfo;
  context: TraceContext;
  prompt: TracePromptInfo | null;
  response: TraceResponseInfo | null;
  timing: TraceTiming;
  outcome: TraceOutcome;
  error: TraceError | null;
};

export type SubmissionStats = {
  /** Requests that reached the model during this prompt's composition. */
  requests: number;
  shown: number;
  accepted: number;
  filtered: number;
  stale: number;
  errors: number;
  accepted_chars: number;
  /** `accepted_chars / chars` - how much of the submitted prompt came from autocomplete. */
  accepted_ratio: number;
};

export type SubmissionTraceRecord = {
  schema: string;
  type: "submission";
  id: string;
  ts: string;
  session: TraceSessionInfo;
  tool: TraceToolInfo;
  /** The submitted prompt, head-truncated to `MAX_SUBMISSION_CHARS`. */
  text: string;
  chars: number;
  lines: number;
  truncated: boolean;
  stats: SubmissionStats;
};

export type AcTraceRecord = CompletionTraceRecord | SubmissionTraceRecord;

/** Caps that keep a single record bounded without losing the parts worth analysing. */
export const MAX_PREFIX_CHARS = 4000;
export const MAX_TYPED_CHARS = 500;
export const MAX_RAW_CHARS = 2000;
export const MAX_PROMPT_CHARS = 8000;
export const MAX_SUBMISSION_CHARS = 8000;
