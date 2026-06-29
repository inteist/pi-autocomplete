import { DEFAULT_PROMPT_MODE, KNOWN_MODEL_PRESETS } from "./constants.js";
import { describePromptMode, isPromptMode, resolvePromptMode } from "./config.js";
import { resolveModelAlias } from "./aliases.js";
import { shouldUseRawGenerate } from "./ollama.js";
import type { GhostConfig, PromptMode } from "./types.js";

export type AutocompleteModelCommandResult =
  | { action: "status" }
  | { action: "list" }
  | { action: "error"; message: string }
  | { action: "set"; model: string; promptMode: PromptMode };

/**
 * Parses user input arguments for the `/ac model` command.
 * It identifies whether the user wants to see the status, list presets,
 * or configure a model (with an optional custom prompt mode).
 *
 * Command patterns supported:
 * - (empty / status / help) -> status
 * - list / ls / models / presets -> list presets
 * - [model] [promptMode] -> set model and promptMode
 * - [promptMode] -> update promptMode only (keeps current model)
 *
 * @param args The raw command arguments passed in the editor console.
 * @param current The current active configuration.
 * @returns AutocompleteModelCommandResult describing the resolved action.
 */
export function parseAutocompleteModelCommand(
  args: string,
  current: GhostConfig,
): AutocompleteModelCommandResult {
  const raw = args.trim();
  const lower = raw.toLowerCase();

  if (!raw || ["status", "current", "help"].includes(lower)) {
    return { action: "status" };
  }

  if (["list", "ls", "models", "presets"].includes(lower)) {
    return { action: "list" };
  }

  const parts = raw.split(/\s+/);
  const last = parts.at(-1)?.toLowerCase();
  let promptMode: PromptMode = DEFAULT_PROMPT_MODE;
  let sawPromptMode = false;

  if (last) {
    const normalizedLast = last === "fim" ? "qwen-fim" : last;
    if (isPromptMode(normalizedLast)) {
      promptMode = normalizedLast;
      sawPromptMode = true;
      parts.pop();
    }
  }

  const modelArg = parts.join(" ").trim();
  if (!modelArg && sawPromptMode) {
    return { action: "set", model: current.model, promptMode };
  }

  if (!modelArg) {
    return {
      action: "error",
      message:
        "Usage: /ac model [model] [auto|qwen-fim|instruct]\nTry: /ac model gemma4:e2b",
    };
  }

  return {
    action: "set",
    model: resolveModelAlias(modelArg),
    promptMode,
  };
}

/**
 * Formats the current autocomplete model, url, and prompt mode details
 * for presentation in the editor notification.
 */
export function formatAutocompleteModelStatus(config: GhostConfig): string[] {
  return [
    "pi-ghost-vim autocomplete model",
    `model: ${config.model}`,
    `prompt mode: ${describePromptMode(config)}`,
    `raw generate: ${shouldUseRawGenerate(resolvePromptMode(config), config.model) ? "yes" : "no"}`,
    `debug trace file: ${config.debugTraceFile}`,
    `run command: ollama run ${config.model}`,
    "status: /ac model gemma4:e2b",
    "modes: auto, qwen-fim, instruct",
  ];
}

/**
 * Formats the list of predefined known models and their options for display.
 */
export function formatKnownModelPresets(): string[] {
  return [
    "pi-ghost-vim known model presets",
    ...KNOWN_MODEL_PRESETS.map(
      (preset) =>
        `${preset.model} — ${preset.label}; mode=${preset.promptMode}; ${preset.runCommand}`,
    ),
    "You can also pass any Ollama model name.",
  ];
}
