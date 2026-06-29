import {
  cleanupCompletion,
  debugText,
  getCompletionRejectionReason,
  getGhostSuppressionReason,
  shouldShowCompletion,
} from "./completion.js";
import { predictWithOllama } from "./ollama.js";
import type { DebugLogger, GhostConfig, GhostState } from "./types.js";
import { formatError } from "./utils.js";

export type PredictionControllerOptions = {
  config: GhostConfig;
  predictor: OllamaPredictor;
  getText: () => string;
  getBlockReason: () => string | null;
  debug: DebugLogger;
  onPrediction: (ghost: GhostState) => void;
};

export class PredictionController {
  private requestId = 0;
  private abort: AbortController | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: PredictionControllerOptions) {}

  schedule(baseText: string): void {
    const requestId = this.nextRequest();

    const suppressionReason = getGhostSuppressionReason(
      baseText,
      this.opts.config.minChars,
    );
    if (suppressionReason) {
      this.opts.debug(`skip #${requestId}: ${suppressionReason}`);
      return;
    }

    const blockReason = this.opts.getBlockReason();
    if (blockReason) {
      this.opts.debug(`skip #${requestId}: ${blockReason}`);
      return;
    }

    this.opts.debug(
      `schedule #${requestId}: len=${baseText.length} in ${this.opts.config.debounceMs}ms`,
    );
    this.debounce = setTimeout(() => {
      void this.runPrediction(baseText, requestId);
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
      clearTimeout(this.debounce);
      this.debounce = null;
    }

    this.abort?.abort();
    this.abort = null;

    return this.requestId;
  }

  private async runPrediction(baseText: string, requestId: number): Promise<void> {
    const controller = new AbortController();
    this.abort = controller;

    const startedAt = Date.now();
    const timeout = setTimeout(() => controller.abort(), this.opts.config.timeoutMs);

    try {
      this.opts.debug(`request #${requestId}: start before=${debugText(baseText)}`);
      const raw = await this.opts.predictor.predict(baseText, "", controller.signal);
      const elapsed = Date.now() - startedAt;
      this.opts.debug(`response #${requestId}: raw=${debugText(raw)}`);

      if (requestId !== this.requestId) {
        this.opts.debug(`drop #${requestId}: stale after ${elapsed}ms`);
        return;
      }
      if (this.opts.getText() !== baseText) {
        this.opts.debug(`drop #${requestId}: text changed after ${elapsed}ms`);
        return;
      }
      const blockReason = this.opts.getBlockReason();
      if (blockReason) {
        this.opts.debug(`drop #${requestId}: ${blockReason} after ${elapsed}ms`);
        return;
      }

      const completion = cleanupCompletion({ before: baseText, raw });
      this.opts.debug(`clean #${requestId}: ${debugText(completion)}`);

      const rejectionReason = getCompletionRejectionReason(completion);
      if (!shouldShowCompletion(completion)) {
        this.opts.debug(`drop #${requestId}: ${rejectionReason ?? "rejected"} after ${elapsed}ms`);
        return;
      }

      this.opts.debug(
        `show #${requestId}: ${completion.length} chars after ${elapsed}ms`,
      );
      this.opts.onPrediction({
        baseText,
        text: completion,
        requestId,
        createdAt: Date.now(),
      });
    } catch (error) {
      const elapsed = Date.now() - startedAt;
      this.opts.debug(`error #${requestId}: ${formatError(error)} after ${elapsed}ms`);
      // Silent failure is best for typing-time autocomplete unless debug is enabled.
    } finally {
      clearTimeout(timeout);
      if (this.abort === controller) this.abort = null;
    }
  }
}

export class OllamaPredictor {
  constructor(private readonly config: GhostConfig) {}

  async predict(before: string, after: string, signal: AbortSignal): Promise<string> {
    return predictWithOllama(before, after, signal, this.config);
  }
}
