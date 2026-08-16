import type {
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteProvider,
  EditorComponent,
  EditorTheme,
  Focusable,
  TUI,
} from "@earendil-works/pi-tui";
import type { TraceRecorder } from "./trace-recorder.js";

export type PromptMode = "auto" | "qwen-fim" | "instruct" | "lfm-prefill";
export type ResolvedPromptMode = Exclude<PromptMode, "auto">;

export type KnownModelPreset = {
  model: string;
  label: string;
  promptMode: ResolvedPromptMode;
  runCommand: string;
};

export type AutocompleteConfig = {
  model: string;
  promptMode: PromptMode;
  ollamaUrl: string;
  keepAlive: string;
  debounceMs: number;
  timeoutMs: number;
  checkTimeoutMs: number;
  doubleTabMs: number;
  minChars: number;
  maxTokens: number;
  inline: boolean;
  debug: boolean;
  /** Records completion traces (accepted/rejected outcomes) to the daily JSONL file. */
  trace: boolean;
  /** Central directory holding the daily trace and debug files. */
  traceDir: string;
};

export type AutocompleteState = {
  baseText: string;
  text: string;
  requestId: number;
  createdAt: number;
};

export type StoredModelSelection = {
  model: string;
  promptMode: PromptMode;
};

export type PersistentConfig = {
  defaultModel?: string;
  defaultPromptMode?: PromptMode;
  lastUsedModel?: string;
  lastUsedPromptMode?: PromptMode;
  traceEnabled?: boolean;
};

export type ModeProvider = () => string;
export type DebugTraceDetails = Record<string, unknown> & {
  /**
   * When true, write the trace to the debug file without adding it to the
   * below-editor debug widget.
   */
  fileOnly?: boolean;
};

export type DebugLogger = (message: string, details?: DebugTraceDetails) => void;
export type ActionHandler = () => void;
export type ExtensionShortcutHandler = (data: string) => boolean;

export type EditorFactory = (
  tui: TUI,
  theme: EditorTheme,
  keybindings: KeybindingsManager,
) => EditorComponent;

export type AutocompleteBaseEditor = EditorComponent &
  Partial<Focusable> & {
    dispose?: () => void;
    getMode?: () => string;
    getCursor?: () => { line: number; col: number };
    getLines?: () => string[];
    isShowingAutocomplete?: () => boolean;
    actionHandlers?: Map<string, ActionHandler>;
    onEscape?: ActionHandler;
    onCtrlD?: ActionHandler;
    onPasteImage?: ActionHandler;
    onExtensionShortcut?: ExtensionShortcutHandler;
    setAutocompleteProvider?: (provider: AutocompleteProvider) => void;
  };

export type AutocompleteWrapperOptions = {
  ctx: ExtensionContext;
  tui: TUI;
  keybindings: KeybindingsManager;
  baseEditor: AutocompleteBaseEditor;
  getExternalMode: ModeProvider;
  config: AutocompleteConfig;
  recorder: TraceRecorder;
  debug: DebugLogger;
  isDebugEnabled?: () => boolean;
};
