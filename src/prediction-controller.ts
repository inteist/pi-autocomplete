import {
  cleanupCompletion,
  debugText,
  getCompletionRejectionReason,
  getAutocompleteSuppressionReason,
} from "./completion.js";
import { resolvePromptMode } from "./config.js";
import {
  predictWithOllama,
  type OllamaPredictionResult,
  type OllamaTraceContext,
} from "./ollama.js";
import {
  emptyContextSnapshot,
  type CompletionOutcomeHint,
  type CompletionTraceDraft,
  type EditorContextSnapshot,
} from "./trace-recorder.js";
import type { DebugLogger, AutocompleteConfig, AutocompleteState } from "./types.js";
import { formatError } from "./utils.js";

export type PredictionControllerOptions = {
  config: AutocompleteConfig;
  predictor: OllamaPredictor;
  getText: () => string;
  getBlockReason: () => string | null;
  debug: DebugLogger;
  onPrediction: (autocomplete: AutocompleteState, trace: CompletionTraceDraft) => void;
  /** Every request that reached the model without producing visible autocomplete text. */
  onTrace: (trace: CompletionTraceDraft) => void;
};

export class PredictionController {
  private requestId = 0;
  private abort: AbortController | null = null;
  private activeRequestId: number | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private debounceRequestId: number | null = null;

  constructor(private readonly opts: PredictionControllerOptions) {}

  schedule(baseText: string, context = emptyContextSnapshot()): void {
    const requestId = this.nextRequest();

    const suppressionReason = getAutocompleteSuppressionReason(
      baseText,
      this.opts.config.minChars,
    );
    if (suppressionReason) {
      this.opts.debug(`skip #${requestId}: ${suppressionReason}`, {
        event: "prediction-skip",
        requestId,
        phase: "schedule",
        reason: suppressionReason,
        textLength: baseText.length,
        trimmedLength: baseText.trim().length,
        minChars: this.opts.config.minChars,
        text: baseText,
      });
      return;
    }

    const blockReason = this.opts.getBlockReason();
    if (blockReason) {
      this.opts.debug(`skip #${requestId}: ${blockReason}`, {
        event: "prediction-skip",
        requestId,
        phase: "schedule",
        reason: blockReason,
        textLength: baseText.length,
        text: baseText,
      });
      return;
    }

    const scheduledAt = Date.now();
    this.opts.debug(
      `schedule #${requestId}: len=${baseText.length} in ${this.opts.config.debounceMs}ms`,
      {
        event: "prediction-schedule",
        requestId,
        debounceMs: this.opts.config.debounceMs,
        timeoutMs: this.opts.config.timeoutMs,
        textLength: baseText.length,
        text: baseText,
      },
    );
    this.debounceRequestId = requestId;
    this.debounce = setTimeout(() => {
      if (this.debounceRequestId === requestId) {
        this.debounceRequestId = null;
        this.debounce = null;
      }
      void this.runPrediction(baseText, requestId, scheduledAt, context);
    }, this.opts.config.debounceMs);
  }

  invalidate(): void {
    this.nextRequest();
  }

  dispose(): void {
    this.nextRequest();
  }

  private nextRequest(): number {
    this.requestId += 1;

    if (this.debounce) {
      const canceledRequestId = this.debounceRequestId;
      clearTimeout(this.debounce);
      this.debounce = null;
      this.debounceRequestId = null;
      this.opts.debug(`cancel #${canceledRequestId ?? this.requestId}: debounce`, {
        event: "prediction-cancel",
        fileOnly: true,
        requestId: canceledRequestId,
        reason: "debounce-cancelled",
      });
    }

    if (this.abort) {
      const abortedRequestId = this.activeRequestId;
      this.opts.debug(`abort #${abortedRequestId ?? this.requestId}: superseded`, {
        event: "prediction-abort",
        fileOnly: true,
        requestId: abortedRequestId,
        reason: "superseded",
      });
      this.abort.abort();
    }
    this.abort = null;
    this.activeRequestId = null;

    return this.requestId;
  }

  private async runPrediction(
    baseText: string,
    requestId: number,
    scheduledAt: number,
    context: EditorContextSnapshot,
  ): Promise<void> {
    const controller = new AbortController();
    this.abort = controller;
    this.activeRequestId = requestId;

    const startedAt = Date.now();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.opts.config.timeoutMs);

    const draft = this.createDraft(baseText, requestId, scheduledAt, startedAt, context);
    const emitTrace = (hint: CompletionOutcomeHint, reason: string | null) => {
      draft.hint = hint;
      draft.reason = reason;
      draft.finishedAt = Date.now();
      this.opts.onTrace(draft);
    };

    try {
      this.opts.debug(`request #${requestId}: start before=${debugText(baseText)}`, {
        event: "prediction-request-start",
        requestId,
        queuedMs: startedAt - scheduledAt,
        timeoutMs: this.opts.config.timeoutMs,
        textLength: baseText.length,
        text: baseText,
      });
      const result = await this.opts.predictor.predict(baseText, "", controller.signal, {
        requestId,
        debug: this.opts.debug,
        onRequest: (request) => {
          draft.request = request;
        },
      });
      const raw = result.response;
      draft.raw = raw;
      draft.request = result.request;
      draft.metrics = result.metrics;
      draft.requestMs = result.elapsedMs;
      const elapsed = Date.now() - startedAt;
      this.opts.debug(`response #${requestId}: raw=${debugText(raw)}`, {
        event: "prediction-raw-response",
        requestId,
        elapsedMs: elapsed,
        rawLength: raw.length,
        raw,
      });

      if (requestId !== this.requestId) {
        this.opts.debug(`drop #${requestId}: stale after ${elapsed}ms`, {
          event: "prediction-drop",
          requestId,
          reason: "stale",
          elapsedMs: elapsed,
          currentRequestId: this.requestId,
        });
        emitTrace("stale", "stale");
        return;
      }
      const currentText = this.opts.getText();
      if (currentText !== baseText) {
        this.opts.debug(`drop #${requestId}: text changed after ${elapsed}ms`, {
          event: "prediction-drop",
          requestId,
          reason: "text-changed",
          elapsedMs: elapsed,
          baseTextLength: baseText.length,
          currentTextLength: currentText.length,
          currentText,
        });
        emitTrace("stale", "text-changed");
        return;
      }
      const blockReason = this.opts.getBlockReason();
      if (blockReason) {
        this.opts.debug(`drop #${requestId}: ${blockReason} after ${elapsed}ms`, {
          event: "prediction-drop",
          requestId,
          reason: blockReason,
          elapsedMs: elapsed,
        });
        emitTrace("stale", blockReason);
        return;
      }

      const completion = cleanupCompletion({ before: baseText, raw });
      draft.completion = completion;
      this.opts.debug(`clean #${requestId}: ${debugText(completion)}`, {
        event: "prediction-clean",
        requestId,
        elapsedMs: elapsed,
        completionLength: completion.length,
        completion,
      });

      const rejectionReason = getCompletionRejectionReason(completion);
      draft.rejectReason = rejectionReason;
      if (rejectionReason) {
        this.opts.debug(`drop #${requestId}: ${rejectionReason} after ${elapsed}ms`, {
          event: "prediction-drop",
          requestId,
          reason: rejectionReason,
          elapsedMs: elapsed,
          completion,
        });
        emitTrace("filtered", rejectionReason);
        return;
      }

      this.opts.debug(
        `show #${requestId}: ${completion.length} chars after ${elapsed}ms`,
        {
          event: "prediction-show",
          requestId,
          elapsedMs: elapsed,
          completionLength: completion.length,
          completion,
        },
      );
      draft.hint = "shown";
      draft.finishedAt = Date.now();
      this.opts.onPrediction(
        {
          baseText,
          text: completion,
          requestId,
          createdAt: draft.finishedAt,
        },
        draft,
      );
    } catch (error) {
      const elapsed = Date.now() - startedAt;
      const formattedError = formatError(error);
      const isAbort =
        error instanceof Error && error.name.toLowerCase() === "aborterror";
      this.opts.debug(
        `${timedOut ? "timeout" : "error"} #${requestId}: ${formattedError} after ${elapsed}ms`,
        {
          event: timedOut ? "prediction-timeout" : "prediction-error",
          requestId,
          elapsedMs: elapsed,
          error: formattedError,
          aborted: isAbort,
          timedOut,
        },
      );
      draft.requestMs = elapsed;
      draft.error = { message: formattedError, timedOut, aborted: isAbort };
      // A superseded request aborts by design; recording it as a failure would drown the
      // real errors in typing noise.
      emitTrace(timedOut || !isAbort ? "error" : "stale", timedOut ? "timeout" : "aborted");
      // Silent failure is best for typing-time autocomplete unless debug is enabled.
    } finally {
      clearTimeout(timeout);
      if (this.abort === controller) this.abort = null;
      if (this.activeRequestId === requestId) this.activeRequestId = null;
    }
  }

  private createDraft(
    baseText: string,
    requestId: number,
    scheduledAt: number,
    startedAt: number,
    context: EditorContextSnapshot,
  ): CompletionTraceDraft {
    return {
      requestId,
      hint: "stale",
      reason: null,
      prefix: baseText,
      suffix: "",
      context,
      model: this.opts.config.model,
      promptMode: this.opts.config.promptMode,
      resolvedPromptMode: resolvePromptMode(this.opts.config),
      request: null,
      raw: null,
      completion: null,
      rejectReason: null,
      metrics: null,
      scheduledAt,
      startedAt,
      finishedAt: startedAt,
      requestMs: null,
      debounceMs: this.opts.config.debounceMs,
      error: null,
    };
  }
}

export class OllamaPredictor {
  constructor(private readonly config: AutocompleteConfig) {}

  async predict(
    before: string,
    after: string,
    signal: AbortSignal,
    trace?: OllamaTraceContext,
  ): Promise<OllamaPredictionResult> {
    return predictWithOllama(before, after, signal, this.config, trace);
  }
}
