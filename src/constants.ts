import type { KnownModelPreset, PromptMode } from "./types.js";

/** Stamped into every trace record; keep in sync with package.json. */
export const EXTENSION_VERSION = "0.1.0";
export const TRACE_TOOL_NAME = "pi-ghost-vim";

export const DEFAULT_MODEL = "gemma4:e4b";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_KEEP_ALIVE = "30m";
export const DEFAULT_CHECK_TIMEOUT_MS = 10_000;
export const DEFAULT_PROMPT_MODE: PromptMode = "auto";

export const MODEL_SELECTION_ENTRY_TYPE = "pi-ghost-vim-model";
export const PROMPT_MODES: readonly PromptMode[] = [
  "auto",
  "qwen-fim",
  "instruct",
  "lfm-prefill",
];
export const KNOWN_MODEL_PRESETS: readonly KnownModelPreset[] = [
  {
    model: "qwen2.5-coder:1.5b",
    label: "Qwen Coder small (FIM)",
    promptMode: "qwen-fim",
    runCommand: "ollama run qwen2.5-coder:1.5b",
  },
  {
    model: "gemma4:e2b",
    label: "Gemma 2B (instruction continuation)",
    promptMode: "instruct",
    runCommand: "ollama run gemma4:e2b",
  },
  {
    model: "gemma4:e4b",
    label: "Gemma 4B (instruction continuation)",
    promptMode: "instruct",
    runCommand: "ollama run gemma4:e4b",
  },
  {
    model: "LFM25:2.6b",
    label: "Liquid LFM2.5 2.6B (prefill continuation)",
    promptMode: "lfm-prefill",
    runCommand: "ollama run LFM25:2.6b",
  },
];

export const DEBUG_WIDGET_KEY = "pi-ghost-vim-debug";
export const GHOST_FACTORY_MARKER = Symbol.for("pi-ghost-vim.editorFactory");

export const SOFTWARE_CURSOR_START = "\x1b[7m";
export const SOFTWARE_CURSOR_RESETS = ["\x1b[0m", "\x1b[27m"] as const;
