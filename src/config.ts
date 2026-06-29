import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import fs from "node:fs";
import {
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_KEEP_ALIVE,
  DEFAULT_MODEL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_PROMPT_MODE,
  MODEL_SELECTION_ENTRY_TYPE,
  PROMPT_MODES,
} from "./constants.js";
import type {
  GhostConfig,
  PromptMode,
  ResolvedPromptMode,
  StoredModelSelection,
  PersistentConfig,
} from "./types.js";

export function describePromptMode(config: GhostConfig): string {
  const resolved = resolvePromptMode(config);
  return config.promptMode === "auto" ? `${resolved} (auto)` : resolved;
}

/**
 * Resolves the active prompt mode into a concrete mode. If configured to `"auto"`,
 * it infers the mode from the model name (Qwen coder models use `"qwen-fim"`,
 * others default to `"instruct"`).
 */
export function resolvePromptMode(config: GhostConfig): ResolvedPromptMode {
  if (config.promptMode !== "auto") return config.promptMode;

  const model = config.model.toLowerCase();
  if (/qwen(?:2\.5|3)?[-_:]?coder/.test(model) || /qwen.*code/.test(model)) {
    return "qwen-fim";
  }

  return "instruct";
}

/**
 * Type guard to check if a string is a valid PromptMode.
 */
export function isPromptMode(value: string): value is PromptMode {
  return (PROMPT_MODES as readonly string[]).includes(value);
}

/**
 * Safely parses a string into a valid PromptMode, falling back to the default if invalid.
 */
export function readPromptMode(value: string | undefined): PromptMode {
  if (!value) return DEFAULT_PROMPT_MODE;
  const normalized = value.trim().toLowerCase();
  const mapped = normalized === "fim" ? "qwen-fim" : normalized;
  return isPromptMode(mapped) ? mapped : DEFAULT_PROMPT_MODE;
}

export function getConfigFilepath(): string {
  return path.join(getAgentDir(), "autocomplete-config.json");
}

export function loadPersistentConfig(): PersistentConfig {
  try {
    const filePath = getConfigFilepath();
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as PersistentConfig;
  } catch {
    return {};
  }
}

export function writePersistentConfig(pConfig: PersistentConfig): void {
  try {
    const filePath = getConfigFilepath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(pConfig, null, 2), "utf-8");
  } catch {
    // Ignore persistence failures
  }
}

export function saveActiveModel(model: string, promptMode: PromptMode): void {
  const pConfig = loadPersistentConfig();
  pConfig.lastUsedModel = model;
  pConfig.lastUsedPromptMode = promptMode;
  writePersistentConfig(pConfig);
}

export function saveDefaultModel(model: string, promptMode: PromptMode): void {
  const pConfig = loadPersistentConfig();
  pConfig.defaultModel = model;
  pConfig.defaultPromptMode = promptMode;
  pConfig.lastUsedModel = model;
  pConfig.lastUsedPromptMode = promptMode;
  writePersistentConfig(pConfig);
}

/**
 * Helper to copy config settings from a source to a target object in place.
 * Mutating the object in place ensures wrappers holding the reference stay updated.
 */
export function replaceConfig(target: GhostConfig, source: GhostConfig): void {
  Object.assign(target, source);
}

/**
 * Applies a stored model selection structure to the active config object.
 */
export function applyStoredModelSelection(
  config: GhostConfig,
  selection: StoredModelSelection | null,
): void {
  if (!selection) return;
  config.model = selection.model;
  config.promptMode = selection.promptMode;
  saveActiveModel(selection.model, selection.promptMode);
}

/**
 * Queries the active Pi extension session manager entries to find and retrieve
 * any custom model selection that was persisted in the current session.
 */
export function readStoredModelSelection(ctx: ExtensionContext): StoredModelSelection | null {
  type EntryLike = { type?: unknown; customType?: unknown; data?: unknown };
  const sessionManager = ctx.sessionManager as {
    getBranch?: () => EntryLike[];
    getEntries?: () => EntryLike[];
  };
  const entries = sessionManager.getBranch?.() ?? sessionManager.getEntries?.() ?? [];
  let selection: StoredModelSelection | null = null;

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== MODEL_SELECTION_ENTRY_TYPE) {
      continue;
    }

    selection = parseStoredModelSelection(entry.data) ?? selection;
  }

  return selection;
}

/**
 * Validates and parses serialized custom model selection data from a session entry.
 */
export function parseStoredModelSelection(data: unknown): StoredModelSelection | null {
  if (!data || typeof data !== "object") return null;

  const entry = data as { model?: unknown; promptMode?: unknown };
  if (typeof entry.model !== "string" || entry.model.trim().length === 0) {
    return null;
  }

  const promptMode =
    typeof entry.promptMode === "string"
      ? readPromptMode(entry.promptMode)
      : DEFAULT_PROMPT_MODE;

  return {
    model: entry.model,
    promptMode,
  };
}

export function readConfigFromEnv(): GhostConfig {
  const pConfig = loadPersistentConfig();
  const defaultModel = pConfig.defaultModel ?? process.env.PI_GHOST_MODEL ?? DEFAULT_MODEL;
  const defaultPromptMode = pConfig.defaultPromptMode ?? readPromptMode(process.env.PI_GHOST_PROMPT_MODE);

  const model = pConfig.lastUsedModel ?? defaultModel;
  const promptMode = pConfig.lastUsedPromptMode ?? defaultPromptMode;

  return {
    model,
    promptMode,
    ollamaUrl: normalizeBaseUrl(
      process.env.PI_GHOST_OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
    ),
    keepAlive: process.env.PI_GHOST_KEEP_ALIVE ?? DEFAULT_KEEP_ALIVE,
    debounceMs: envNumber("PI_GHOST_DEBOUNCE_MS", 250),
    timeoutMs: envNumber("PI_GHOST_TIMEOUT_MS", 2500),
    checkTimeoutMs: envNumber("PI_GHOST_CHECK_TIMEOUT_MS", DEFAULT_CHECK_TIMEOUT_MS),
    doubleTabMs: envNumber("PI_GHOST_DOUBLE_TAB_MS", 350),
    minChars: envNumber("PI_GHOST_MIN_CHARS", 8),
    maxTokens: envNumber("PI_GHOST_MAX_TOKENS", 48),
    inline: envBool("PI_GHOST_INLINE", true),
    debug: envBool("PI_GHOST_DEBUG", false),
    debugTraceFile: readDebugTraceFilePath(),
  };
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readDebugTraceFilePath(): string {
  const trimmed = [
    process.env.PI_GHOST_DEBUG_FILE,
    process.env.PI_GHOST_TRACE_FILE,
    process.env.PI_GHOST_DEBUG_TRACE_FILE,
  ]
    .map((value) => value?.trim())
    .find((value): value is string => !!value);

  if (trimmed) {
    return path.isAbsolute(trimmed) ? trimmed : path.resolve(trimmed);
  }

  return path.join(getAgentDir(), "pi-ghost-vim-debug.jsonl");
}

export function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
