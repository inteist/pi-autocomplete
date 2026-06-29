import { describePromptMode, resolvePromptMode } from "./config.js";
import { cleanupCompletion, getCompletionRejectionReason } from "./completion.js";
import type { DebugLogger, GhostConfig, ResolvedPromptMode } from "./types.js";
import { formatError, previewForLine } from "./utils.js";

export type OllamaTraceContext = {
  requestId: number;
  debug: DebugLogger;
};

export async function predictWithOllama(
  before: string,
  after: string,
  signal: AbortSignal,
  config: GhostConfig,
  trace?: OllamaTraceContext,
): Promise<string> {
  const url = `${config.ollamaUrl}/api/generate`;
  const request = buildGenerateRequest(before, after, config, config.maxTokens);
  const requestBody = JSON.stringify(request);
  const resolvedPromptMode = resolvePromptMode(config);
  const startedAt = Date.now();

  trace?.debug(
    `ollama #${trace.requestId}: POST /api/generate model=${request.model} prompt=${request.prompt.length} chars`,
    {
      event: "ollama-request",
      requestId: trace.requestId,
      url,
      model: request.model,
      promptMode: config.promptMode,
      resolvedPromptMode,
      raw: request.raw,
      keepAlive: request.keep_alive,
      options: request.options,
      promptLength: request.prompt.length,
      beforeLength: before.length,
      afterLength: after.length,
      prompt: request.prompt,
      before,
      after,
    },
  );

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: requestBody,
  });
  const headersElapsed = Date.now() - startedAt;

  if (!res.ok) {
    const body = await safeReadResponseText(res);
    const elapsed = Date.now() - startedAt;
    trace?.debug(
      `ollama #${trace.requestId}: HTTP ${res.status} after ${elapsed}ms`,
      {
        event: "ollama-http-error",
        requestId: trace.requestId,
        status: res.status,
        statusText: res.statusText,
        headersElapsedMs: headersElapsed,
        elapsedMs: elapsed,
        body,
      },
    );
    throw new Error(`Ollama HTTP ${res.status}: ${previewForLine(body, 160)}`);
  }

  const json = (await res.json()) as OllamaGenerateResponse;
  const elapsed = Date.now() - startedAt;
  if (typeof json.error === "string" && json.error.length > 0) {
    trace?.debug(
      `ollama #${trace.requestId}: API error after ${elapsed}ms`,
      {
        event: "ollama-api-error",
        requestId: trace.requestId,
        headersElapsedMs: headersElapsed,
        elapsedMs: elapsed,
        error: json.error,
      },
    );
    throw new Error(`Ollama error: ${previewForLine(json.error, 160)}`);
  }

  const response = typeof json.response === "string" ? json.response : "";
  const metrics = extractOllamaMetrics(json);
  trace?.debug(
    `ollama #${trace.requestId}: response ${response.length} chars after ${elapsed}ms${formatOllamaMetrics(metrics)}`,
    {
      event: "ollama-response",
      requestId: trace.requestId,
      status: res.status,
      headersElapsedMs: headersElapsed,
      elapsedMs: elapsed,
      responseLength: response.length,
      response,
      metrics,
    },
  );

  return response;
}

export type OllamaGenerateRequest = {
  model: string;
  prompt: string;
  raw: boolean;
  stream: false;
  keep_alive: string;
  options: {
    temperature: number;
    top_p: number;
    num_predict: number;
    num_ctx: number;
    repeat_penalty: number;
    stop: string[];
  };
};

/**
 * Constructs the body payload for the Ollama `/api/generate` request.
 * Depending on the active model's prompt mode, this will use either
 * Fill-in-the-Middle (FIM) formatting or an instruction-based template.
 *
 * @param before Text to the left of the cursor.
 * @param after Text to the right of the cursor.
 * @param config The active autocomplete configuration.
 * @param maxTokens The maximum number of tokens to predict.
 * @returns The formatted request payload ready to be sent to Ollama.
 */
export function buildGenerateRequest(
  before: string,
  after: string,
  config: GhostConfig,
  maxTokens: number,
): OllamaGenerateRequest {
  const promptMode = resolvePromptMode(config);

  return {
    model: config.model,
    prompt:
      promptMode === "qwen-fim"
        ? buildQwenFimPrompt(before, after)
        : buildInstructionPrompt(before, after),
    raw: shouldUseRawGenerate(promptMode, config.model),
    stream: false,
    keep_alive: config.keepAlive,
    options: {
      temperature: 0,
      top_p: 0.9,
      num_predict: maxTokens,
      num_ctx: 4096,
      repeat_penalty: 1.05,
      stop: getStopTokens(promptMode),
    },
  };
}

/**
 * Formats the prefix and suffix context using Qwen coder FIM (Fill-in-the-Middle) tokens.
 * FIM allows the model to predict the middle section between existing text.
 * 
 * Context window bounds are applied:
 * - Up to 2500 characters of preceding context (approx. 500-600 tokens).
 * - Up to 1000 characters of succeeding context (approx. 200-250 tokens).
 *
 * @param before Text to the left of the cursor.
 * @param after Text to the right of the cursor.
 * @returns A raw string formatted with FIM control tokens.
 */
export function buildQwenFimPrompt(before: string, after = ""): string {
  return [
    "<|fim_prefix|>",
    before.slice(-2500),
    "<|fim_suffix|>",
    after.slice(0, 1000),
    "<|fim_middle|>",
  ].join("");
}

// Gemma 4's Ollama renderer/parser can return an empty `/api/generate`
// response for continuation prompts unless raw generation is used.
export function shouldUseRawGenerate(
  promptMode: ResolvedPromptMode,
  model: string,
): boolean {
  if (promptMode === "qwen-fim") return true;
  return isGemmaModel(model);
}

export function isGemmaModel(model: string): boolean {
  return /^gemma(?:\d|[-_:]|$)/i.test(model.trim());
}

/**
 * Formats the prefix and suffix context as an instruction prompt for models that
 * do not support raw FIM completion. Tells the model to behave as an autocomplete
 * continuation engine and only output the continuation.
 *
 * Context window bounds are applied:
 * - Up to 2500 characters of preceding context.
 * - Up to 1000 characters of succeeding context (if any is present).
 *
 * @param before Text to the left of the cursor.
 * @param after Text to the right of the cursor.
 * @returns A plain text instruction prompt.
 */
export function buildInstructionPrompt(before: string, after = ""): string {
  const suffix = after.trim()
    ? `\nText after cursor:\n${after.slice(0, 1000)}`
    : "";

  return [
    "You are keyboard autocomplete. Continue exactly from <cursor>.",
    "Output only the characters that come after <cursor>.",
    "If a word is unfinished, output only the remaining letters.",
    "Do not explain, quote, or repeat existing text.",
    "",
    "Text:",
    `${before.slice(-2500)}<cursor>`,
    suffix,
    "Completion:",
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

/**
 * Resolves the appropriate set of stop tokens to prevent the model from escaping
 * the autocomplete context or generating additional dialogue turns/metadata.
 *
 * @param promptMode The resolved prompt mode ("qwen-fim" or "instruct").
 * @returns An array of string tokens that trigger generation termination.
 */
export function getStopTokens(promptMode: ResolvedPromptMode): string[] {
  if (promptMode === "qwen-fim") {
    return [
      "<|fim_prefix|>",
      "<|fim_suffix|>",
      "<|fim_middle|>",
      "<|endoftext|>",
      "<|im_start|>",
      "<|im_end|>",
      "\n\n\n",
    ];
  }

  return [
    "<start_of_turn>",
    "<end_of_turn>",
    "<|im_start|>",
    "<|im_end|>",
    "<|endoftext|>",
    "\nText:",
    "\nText before cursor:",
    "\nText after cursor:",
    "\nCompletion:",
    "\nContinuation:",
    "\nUser:",
    "\nAssistant:",
    "\n\n\n",
  ];
}

type OllamaTagsResponse = {
  models?: Array<{ name?: unknown; model?: unknown }>;
};

type OllamaGenerateResponse = {
  response?: unknown;
  error?: unknown;
  done?: unknown;
  done_reason?: unknown;
  total_duration?: unknown;
  load_duration?: unknown;
  prompt_eval_count?: unknown;
  prompt_eval_duration?: unknown;
  eval_count?: unknown;
  eval_duration?: unknown;
};

function extractOllamaMetrics(json: OllamaGenerateResponse): Record<string, unknown> {
  const metrics: Record<string, unknown> = {};

  copyMetric(json, metrics, "done");
  copyMetric(json, metrics, "done_reason");
  copyMetric(json, metrics, "total_duration");
  copyMetric(json, metrics, "load_duration");
  copyMetric(json, metrics, "prompt_eval_count");
  copyMetric(json, metrics, "prompt_eval_duration");
  copyMetric(json, metrics, "eval_count");
  copyMetric(json, metrics, "eval_duration");

  addDurationMs(metrics, "total_duration", "totalMs");
  addDurationMs(metrics, "load_duration", "loadMs");
  addDurationMs(metrics, "prompt_eval_duration", "promptEvalMs");
  addDurationMs(metrics, "eval_duration", "evalMs");

  return metrics;
}

function copyMetric(
  source: OllamaGenerateResponse,
  target: Record<string, unknown>,
  key: keyof OllamaGenerateResponse,
): void {
  const value = source[key];
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    target[key] = value;
  }
}

function addDurationMs(
  metrics: Record<string, unknown>,
  nsKey: string,
  msKey: string,
): void {
  const ns = metrics[nsKey];
  if (typeof ns !== "number" || !Number.isFinite(ns)) return;
  metrics[msKey] = Math.round((ns / 1_000_000) * 100) / 100;
}

function formatOllamaMetrics(metrics: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof metrics.totalMs === "number") parts.push(`total=${metrics.totalMs}ms`);
  if (typeof metrics.loadMs === "number") parts.push(`load=${metrics.loadMs}ms`);
  if (typeof metrics.promptEvalMs === "number") {
    parts.push(`prompt=${metrics.promptEvalMs}ms/${metrics.prompt_eval_count ?? "?"}tok`);
  }
  if (typeof metrics.evalMs === "number") {
    parts.push(`eval=${metrics.evalMs}ms/${metrics.eval_count ?? "?"}tok`);
  }

  return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

/**
 * Diagnostic function executed by the `/ac status` command.
 * It:
 * 1. Checks connectivity to the local Ollama API tags endpoint.
 * 2. Validates that the configured model is installed (pulled) locally in Ollama.
 * 3. Triggers a small test completion generation to verify end-to-end integration,
 *    measuring roundtrip response time and validating the output cleanup logic.
 *
 * @param config The active configuration containing Ollama URL and model.
 * @param promptArg An optional custom prompt override for the test generation.
 * @returns An object with diagnostic success boolean and status lines to be shown to the user.
 */
export async function runOllamaStatus(
  config: GhostConfig,
  promptArg: string,
): Promise<{ ok: boolean; lines: string[] }> {
  const lines = [
    "pi-ghost-vim Ollama status",
    `url: ${config.ollamaUrl}`,
    `model: ${config.model}`,
    `prompt mode: ${describePromptMode(config)}`,
    `raw generate: ${shouldUseRawGenerate(resolvePromptMode(config), config.model) ? "yes" : "no"}`,
    `run command: ollama run ${config.model}`,
    `generate timeout: ${config.checkTimeoutMs}ms`,
  ];

  try {
    const tagsRes = await fetchWithTimeout(
      `${config.ollamaUrl}/api/tags`,
      { method: "GET" },
      Math.min(config.checkTimeoutMs, 5_000),
    );

    if (!tagsRes.ok) {
      lines.push(`tags: HTTP ${tagsRes.status} ${tagsRes.statusText}`);
      lines.push(`tags body: ${previewForLine(await safeReadResponseText(tagsRes), 160)}`);
    } else {
      const tags = (await tagsRes.json()) as OllamaTagsResponse;
      const modelNames = (tags.models ?? [])
        .map((model) =>
          typeof model.name === "string"
            ? model.name
            : typeof model.model === "string"
              ? model.model
              : "",
        )
        .filter(Boolean);
      const modelFound = modelNames.includes(config.model);
      lines.push(`tags: ok (${modelNames.length} model${modelNames.length === 1 ? "" : "s"})`);
      lines.push(`configured model: ${modelFound ? "found" : "MISSING"}`);
      if (!modelFound) lines.push(`pull it with: ollama pull ${config.model}`);
      if (!modelFound) lines.push(`or start it with: ollama run ${config.model}`);
    }
  } catch (error) {
    lines.push(`tags: ${formatError(error)}`);
  }

  const prompt = promptArg || "I would like to add command that";
  try {
    const startedAt = Date.now();
    const generateRes = await fetchWithTimeout(
      `${config.ollamaUrl}/api/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildGenerateRequest(prompt, "", config, Math.min(config.maxTokens, 24)),
        ),
      },
      config.checkTimeoutMs,
    );
    const elapsed = Date.now() - startedAt;

    if (!generateRes.ok) {
      lines.push(
        `generate: HTTP ${generateRes.status} ${generateRes.statusText} after ${elapsed}ms`,
      );
      lines.push(`generate body: ${previewForLine(await safeReadResponseText(generateRes), 240)}`);
      return { ok: false, lines };
    }

    const json = (await generateRes.json()) as OllamaGenerateResponse;
    if (typeof json.error === "string" && json.error.length > 0) {
      lines.push(`generate: Ollama error after ${elapsed}ms`);
      lines.push(`error: ${previewForLine(json.error, 240)}`);
      return { ok: false, lines };
    }

    const raw = typeof json.response === "string" ? json.response : "";
    const cleaned = cleanupCompletion({ before: prompt, raw });
    const rejectionReason = getCompletionRejectionReason(cleaned);
    lines.push(`generate: ok after ${elapsed}ms`);
    lines.push(`raw response: ${previewForLine(raw || "(empty)", 240)}`);
    lines.push(`cleaned: ${previewForLine(cleaned || "(empty)", 240)}`);
    if (rejectionReason) lines.push(`visibility: rejected (${rejectionReason})`);
    else lines.push("visibility: would show");
    return { ok: true, lines };
  } catch (error) {
    lines.push(`generate: ${formatError(error)}`);
    return { ok: false, lines };
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function safeReadResponseText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (error) {
    return formatError(error);
  }
}
