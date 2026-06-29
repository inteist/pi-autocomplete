import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type AutocompleteProvider,
  type EditorComponent,
  type EditorTheme,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";

type PromptMode = "auto" | "qwen-fim" | "instruct";
type ResolvedPromptMode = Exclude<PromptMode, "auto">;

type KnownModelPreset = {
  model: string;
  label: string;
  promptMode: ResolvedPromptMode;
  runCommand: string;
};

const DEFAULT_MODEL = "qwen2.5-coder:1.5b";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_KEEP_ALIVE = "30m";
const DEFAULT_CHECK_TIMEOUT_MS = 10_000;
const DEFAULT_PROMPT_MODE: PromptMode = "auto";

const MODEL_SELECTION_ENTRY_TYPE = "pi-ghost-vim-model";
const PROMPT_MODES: readonly PromptMode[] = ["auto", "qwen-fim", "instruct"];
const KNOWN_MODEL_PRESETS: readonly KnownModelPreset[] = [
  {
    model: "qwen2.5-coder:1.5b",
    label: "Qwen Coder small (FIM)",
    promptMode: "qwen-fim",
    runCommand: "ollama run qwen2.5-coder:1.5b",
  },
  {
    model: "gemma4:e2b",
    label: "Gemma (instruction continuation)",
    promptMode: "instruct",
    runCommand: "ollama run gemma4:e2b",
  },
];

const DEBUG_WIDGET_KEY = "pi-ghost-vim-debug";
const GHOST_FACTORY_MARKER = Symbol.for("pi-ghost-vim.editorFactory");

const SOFTWARE_CURSOR_START = "\x1b[7m";
const SOFTWARE_CURSOR_RESETS = ["\x1b[0m", "\x1b[27m"] as const;

type GhostConfig = {
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
};

type GhostState = {
  baseText: string;
  text: string;
  requestId: number;
  createdAt: number;
};

type ModeProvider = () => string;
type DebugLogger = (message: string) => void;
type ActionHandler = () => void;
type ExtensionShortcutHandler = (data: string) => boolean;
type EditorFactory = (
  tui: TUI,
  theme: EditorTheme,
  keybindings: KeybindingsManager,
) => EditorComponent;
type GhostEditorFactory = EditorFactory & {
  [GHOST_FACTORY_MARKER]?: true;
  previousFactory?: EditorFactory;
};

type GhostBaseEditor = EditorComponent &
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
  };

type GhostWrapperOptions = {
  ctx: ExtensionContext;
  tui: TUI;
  keybindings: KeybindingsManager;
  baseEditor: GhostBaseEditor;
  getExternalMode: ModeProvider;
  config: GhostConfig;
  debug: DebugLogger;
};

export default function ghostVim(pi: ExtensionAPI): void {
  let vimMode = "insert";
  let debugEnabled = envBool("PI_GHOST_DEBUG", false);
  const config = readConfigFromEnv();
  const debugHistory: string[] = [];
  const wrappers = new Set<GhostVimWrapper>();

  const disposeWrappers = () => {
    for (const wrapper of wrappers) wrapper.dispose();
    wrappers.clear();
  };

  const debug = (ctx: ExtensionContext, message: string) => {
    if (!debugEnabled) return;

    const time = new Date().toLocaleTimeString();
    const line = dimWithTheme(ctx, `[${time}] ${message}`);
    debugHistory.push(line);
    while (debugHistory.length > 8) debugHistory.shift();
    setGhostWidget(ctx, DEBUG_WIDGET_KEY, debugHistory);
  };

  const eventBus = (pi as ExtensionAPI & {
    events?: {
      on?: (eventName: string, handler: (event: unknown) => void) => unknown;
    };
  }).events;

  eventBus?.on?.("pi-vim:mode-change", (event: unknown) => {
    if (typeof event === "string") {
      vimMode = event;
      return;
    }
    if (
      typeof event === "object" &&
      event !== null &&
      typeof (event as { mode?: unknown }).mode === "string"
    ) {
      vimMode = (event as { mode: string }).mode;
    }
  });

  pi.registerCommand("autocomplete-debug", {
    description: "Toggle autocomplete debug logging (usage: /autocomplete-debug [on|off])",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (["on", "1", "true", "yes", "enable", "enabled"].includes(arg)) {
        debugEnabled = true;
      } else if (["off", "0", "false", "no", "disable", "disabled"].includes(arg)) {
        debugEnabled = false;
      } else {
        debugEnabled = !debugEnabled;
      }

      if (!debugEnabled) {
        debugHistory.length = 0;
        clearGhostWidget(ctx, DEBUG_WIDGET_KEY);
        ctx.ui.notify("pi-ghost-vim debug disabled", "info");
        return;
      }

      debugHistory.length = 0;
      setGhostWidget(ctx, DEBUG_WIDGET_KEY, [
        "pi-ghost-vim debug enabled",
        `url=${config.ollamaUrl}`,
        `model=${config.model}`,
        `prompt=${describePromptMode(config)}`,
        `debounce=${config.debounceMs}ms timeout=${config.timeoutMs}ms minChars=${config.minChars}`,
      ]);
      ctx.ui.notify("pi-ghost-vim debug enabled", "info");
    },
  });

  pi.registerCommand("autocomplete-model", {
    description:
      "Show or change autocomplete model (usage: /autocomplete-model [model] [auto|qwen-fim|instruct])",
    handler: async (args, ctx) => {
      const result = parseAutocompleteModelCommand(args, config);

      if (result.action === "status") {
        ctx.ui.notify(formatAutocompleteModelStatus(config).join("\n"), "info");
        return;
      }

      if (result.action === "list") {
        ctx.ui.notify(formatKnownModelPresets().join("\n"), "info");
        return;
      }

      if (result.action === "error") {
        ctx.ui.notify(result.message, "warning");
        return;
      }

      config.model = result.model;
      config.promptMode = result.promptMode;
      pi.appendEntry(MODEL_SELECTION_ENTRY_TYPE, {
        model: config.model,
        promptMode: config.promptMode,
        updatedAt: Date.now(),
      });

      for (const wrapper of wrappers) wrapper.handleConfigChanged();

      ctx.ui.notify(
        [
          "pi-ghost-vim model updated",
          `model: ${config.model}`,
          `prompt mode: ${describePromptMode(config)}`,
          `run command: ollama run ${config.model}`,
          "Use /autocomplete-check to validate it.",
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("autocomplete-check", {
    description: "Check autocomplete Ollama connectivity and configured model",
    handler: async (args, ctx) => {
      ctx.ui.notify("pi-ghost-vim: checking Ollama...", "info");
      const result = await runOllamaCheck(config, args.trim());
      printOllamaCheckOutput(ctx, result);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    disposeWrappers();
    const currentFactory = ctx.ui.getEditorComponent?.() as EditorFactory | undefined;
    const previousFactory = unwrapGhostFactory(currentFactory);

    if (!previousFactory) {
      ctx.ui.notify?.(
        "pi-ghost-vim: no existing custom editor found; load this after pi-vim",
        "warning",
      );
    }

    replaceConfig(config, readConfigFromEnv());
    applyStoredModelSelection(config, readStoredModelSelection(ctx));
    debugEnabled = debugEnabled || config.debug;
    debug(
      ctx,
      `session_start model=${config.model} prompt=${describePromptMode(config)} url=${config.ollamaUrl}`,
    );

    const factory = ((tui, theme, keybindings) => {
      const baseEditor = previousFactory
        ? previousFactory(tui, theme, keybindings)
        : new CustomEditor(tui, theme, keybindings);

      const wrapper = new GhostVimWrapper({
        ctx,
        tui,
        keybindings,
        baseEditor: baseEditor as GhostBaseEditor,
        getExternalMode: () => vimMode,
        config,
        debug: (message) => debug(ctx, message),
      });
      wrappers.add(wrapper);
      return wrapper;
    }) as GhostEditorFactory;

    factory[GHOST_FACTORY_MARKER] = true;
    factory.previousFactory = previousFactory;
    ctx.ui.setEditorComponent(factory);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    disposeWrappers();
    clearGhostWidget(ctx, DEBUG_WIDGET_KEY);
  });
}

class GhostVimWrapper implements EditorComponent, Focusable {
  public readonly actionHandlers: Map<string, ActionHandler>;

  private ghost: GhostState | null = null;
  private lastTabAt = 0;
  private ownFocused = false;
  private disposed = false;
  private _onEscape: ActionHandler | undefined;
  private _onCtrlD: ActionHandler | undefined;
  private _onPasteImage: ActionHandler | undefined;
  private _onExtensionShortcut: ExtensionShortcutHandler | undefined;
  private readonly predictions: PredictionController;

  constructor(private readonly opts: GhostWrapperOptions) {
    this.actionHandlers = new ForwardingActionHandlersMap(
      () => this.opts.baseEditor.actionHandlers,
    );
    this.predictions = new PredictionController({
      config: opts.config,
      predictor: new OllamaPredictor(opts.config),
      getText: () => this.getText(),
      getBlockReason: () => this.getPredictionBlockReason(),
      debug: (message) => this.opts.debug(message),
      onPrediction: (ghost) => {
        this.ghost = ghost;
        this.showGhostPreview(ghost.text);
        this.requestRender();
      },
    });
  }

  get focused(): boolean {
    return typeof this.opts.baseEditor.focused === "boolean"
      ? this.opts.baseEditor.focused
      : this.ownFocused;
  }

  set focused(value: boolean) {
    this.ownFocused = value;
    if ("focused" in this.opts.baseEditor) {
      this.opts.baseEditor.focused = value;
    }
  }

  get wantsKeyRelease(): boolean | undefined {
    return this.opts.baseEditor.wantsKeyRelease;
  }

  set wantsKeyRelease(value: boolean | undefined) {
    this.opts.baseEditor.wantsKeyRelease = value;
  }

  get onEscape(): ActionHandler | undefined {
    return this._onEscape ?? this.opts.baseEditor.onEscape;
  }

  set onEscape(handler: ActionHandler | undefined) {
    this._onEscape = handler;
    this.opts.baseEditor.onEscape = handler;
  }

  get onCtrlD(): ActionHandler | undefined {
    return this._onCtrlD ?? this.opts.baseEditor.onCtrlD;
  }

  set onCtrlD(handler: ActionHandler | undefined) {
    this._onCtrlD = handler;
    this.opts.baseEditor.onCtrlD = handler;
  }

  get onPasteImage(): ActionHandler | undefined {
    return this._onPasteImage ?? this.opts.baseEditor.onPasteImage;
  }

  set onPasteImage(handler: ActionHandler | undefined) {
    this._onPasteImage = handler;
    this.opts.baseEditor.onPasteImage = handler;
  }

  get onExtensionShortcut(): ExtensionShortcutHandler | undefined {
    return this._onExtensionShortcut ?? this.opts.baseEditor.onExtensionShortcut;
  }

  set onExtensionShortcut(handler: ExtensionShortcutHandler | undefined) {
    this._onExtensionShortcut = handler;
    this.opts.baseEditor.onExtensionShortcut = handler;
  }

  get onSubmit(): ((text: string) => void) | undefined {
    return this.opts.baseEditor.onSubmit;
  }

  set onSubmit(handler: ((text: string) => void) | undefined) {
    this.opts.baseEditor.onSubmit = handler;
  }

  get onChange(): ((text: string) => void) | undefined {
    return this.opts.baseEditor.onChange;
  }

  set onChange(handler: ((text: string) => void) | undefined) {
    this.opts.baseEditor.onChange = handler;
  }

  get borderColor(): ((str: string) => string) | undefined {
    return this.opts.baseEditor.borderColor;
  }

  set borderColor(colorizer: ((str: string) => string) | undefined) {
    this.opts.baseEditor.borderColor = colorizer;
  }

  render(width: number): string[] {
    const lines = this.opts.baseEditor.render(width);

    if (
      !this.opts.config.inline ||
      !this.isInsertMode() ||
      !this.hasValidGhost()
    ) {
      return lines;
    }

    return injectGhostAfterCursor(lines, this.ghost!.text, width, (text) =>
      this.dim(text),
    );
  }

  handleInput(data: string): void {
    if (!this.isInsertMode()) {
      this.invalidateGhostAndPrediction();
      this.opts.baseEditor.handleInput?.(data);
      this.requestRender();
      return;
    }

    const isTab = matchesKey(data, Key.tab);
    const isEscape = matchesKey(data, Key.escape);

    if (isTab && this.hasValidGhost()) {
      this.handleGhostTab();
      this.requestRender();
      return;
    }

    if (isTab) {
      this.invalidateGhostAndPrediction();
      this.lastTabAt = 0;
      this.opts.baseEditor.handleInput?.(data);
      this.requestRender();
      return;
    }

    if (isEscape) {
      if (this.hasValidGhost()) {
        this.invalidateGhostAndPrediction();
        this.requestRender();
        return;
      }

      this.invalidateGhostAndPrediction();
      this.opts.baseEditor.handleInput?.(data);
      this.requestRender();
      return;
    }

    this.lastTabAt = 0;

    const before = this.getText();
    this.invalidateGhostAndPrediction();

    this.opts.baseEditor.handleInput?.(data);

    const after = this.getText();
    if (after !== before) {
      this.schedulePrediction(after);
    }

    this.requestRender();
  }

  invalidate(): void {
    this.opts.baseEditor.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.predictions.dispose();
    this.clearGhost();
    this.opts.baseEditor.dispose?.();
  }

  handleConfigChanged(): void {
    this.opts.debug(
      `config: model=${this.opts.config.model} prompt=${describePromptMode(this.opts.config)}`,
    );
    this.invalidateGhostAndPrediction();
    this.requestRender();
  }

  getText(): string {
    return this.opts.baseEditor.getText();
  }

  setText(text: string): void {
    this.opts.baseEditor.setText(text);
  }

  getExpandedText(): string {
    return this.opts.baseEditor.getExpandedText?.() ?? this.getText();
  }

  addToHistory(text: string): void {
    this.opts.baseEditor.addToHistory?.(text);
  }

  insertTextAtCursor(text: string): void {
    if (this.opts.baseEditor.insertTextAtCursor) {
      this.opts.baseEditor.insertTextAtCursor(text);
      return;
    }
    this.setText(this.getText() + text);
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.opts.baseEditor.setAutocompleteProvider?.(provider);
  }

  setPaddingX(padding: number): void {
    this.opts.baseEditor.setPaddingX?.(padding);
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.opts.baseEditor.setAutocompleteMaxVisible?.(maxVisible);
  }

  private getMode(): string {
    const mode = this.opts.baseEditor.getMode?.() ?? this.opts.getExternalMode();
    return String(mode ?? "insert").toLowerCase();
  }

  private isInsertMode(): boolean {
    return this.getMode() === "insert";
  }

  private canShowGhostNow(): boolean {
    return this.getPredictionBlockReason() === null;
  }

  private getPredictionBlockReason(): string | null {
    const mode = this.getMode();
    if (mode !== "insert") return `mode=${mode}`;
    if (!this.isCursorAtEnd()) return "cursor-not-at-end";
    if (this.isNativeAutocompleteShowing()) return "native-autocomplete-open";
    return null;
  }

  private hasValidGhost(): boolean {
    return (
      !!this.ghost &&
      this.ghost.text.length > 0 &&
      this.getText() === this.ghost.baseText &&
      this.canShowGhostNow()
    );
  }

  private isCursorAtEnd(): boolean {
    const getCursor = this.opts.baseEditor.getCursor;
    if (!getCursor) return true;

    const cursor = getCursor.call(this.opts.baseEditor);
    if (
      !cursor ||
      !Number.isInteger(cursor.line) ||
      !Number.isInteger(cursor.col)
    ) {
      return true;
    }

    const lines = this.opts.baseEditor.getLines?.() ?? this.getText().split("\n");
    const lastLine = lines.length - 1;
    if (cursor.line !== lastLine) return false;

    return cursor.col === (lines[lastLine] ?? "").length;
  }

  private isNativeAutocompleteShowing(): boolean {
    try {
      return this.opts.baseEditor.isShowingAutocomplete?.() === true;
    } catch {
      return false;
    }
  }

  private handleGhostTab(): void {
    const now = Date.now();

    if (now - this.lastTabAt <= this.opts.config.doubleTabMs) {
      this.opts.debug("accept: whole ghost via double-tab");
      this.acceptWholeGhost();
      this.lastTabAt = 0;
      return;
    }

    const hasRest = this.acceptNextChunk();
    this.lastTabAt = hasRest ? now : 0;
  }

  private acceptNextChunk(): boolean {
    if (!this.ghost) return false;

    const { take, rest } = takeNextChunk(this.ghost.text);
    if (!take) return this.ghost.text.length > 0;

    const nextText = this.getText() + take;
    this.opts.debug(`accept: chunk ${take.length} chars, rest=${rest.length}`);
    this.setText(nextText);

    if (rest.length > 0) {
      this.ghost = {
        ...this.ghost,
        baseText: nextText,
        text: rest,
      };
      this.showGhostPreview(rest);
      return true;
    }

    this.clearGhost();
    return false;
  }

  private acceptWholeGhost(): void {
    if (!this.ghost) return;

    this.opts.debug(`accept: whole ${this.ghost.text.length} chars`);
    this.setText(this.getText() + this.ghost.text);
    this.clearGhost();
  }

  private schedulePrediction(text: string): void {
    this.predictions.schedule(text);
  }

  private invalidateGhostAndPrediction(): void {
    this.clearGhost();
    this.predictions.invalidate();
  }

  private clearGhost(): void {
    this.ghost = null;
    this.clearGhostPreview();
  }

  private showGhostPreview(text: string): void {
    const oneLine = text.split("\n")[0] ?? "";
    if (!oneLine) {
      this.clearGhostPreview();
      return;
    }

    const preview = oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine;
    const line = this.dim(`ghost: ${preview}`);
    const ui = this.opts.ctx.ui as ExtensionContext["ui"] & {
      setWidget?: ExtensionContext["ui"]["setWidget"];
      setStatus?: ExtensionContext["ui"]["setStatus"];
    };

    if (typeof ui.setWidget === "function") {
      ui.setWidget("pi-ghost-vim", [line], { placement: "belowEditor" });
      return;
    }

    ui.setStatus?.("pi-ghost-vim", line);
  }

  private clearGhostPreview(): void {
    const ui = this.opts.ctx.ui as ExtensionContext["ui"] & {
      setWidget?: ExtensionContext["ui"]["setWidget"];
      setStatus?: ExtensionContext["ui"]["setStatus"];
    };

    ui.setWidget?.("pi-ghost-vim", undefined);
    ui.setStatus?.("pi-ghost-vim", undefined);
  }

  private dim(text: string): string {
    return this.opts.ctx.ui.theme?.fg?.("dim", text) ?? text;
  }

  private requestRender(): void {
    this.opts.baseEditor.invalidate();
    this.opts.tui.requestRender?.();
  }
}

class ForwardingActionHandlersMap extends Map<string, ActionHandler> {
  constructor(private readonly getTarget: () => Map<string, ActionHandler> | undefined) {
    super();
  }

  override set(key: string, value: ActionHandler): this {
    super.set(key, value);
    const target = this.getTarget();
    if (target && target !== this) target.set(key, value);
    return this;
  }

  override delete(key: string): boolean {
    const deleted = super.delete(key);
    const target = this.getTarget();
    if (target && target !== this) target.delete(key);
    return deleted;
  }

  override clear(): void {
    super.clear();
    const target = this.getTarget();
    if (target && target !== this) target.clear();
  }
}

function unwrapGhostFactory(factory: EditorFactory | undefined): EditorFactory | undefined {
  const ghostFactory = factory as GhostEditorFactory | undefined;
  if (ghostFactory?.[GHOST_FACTORY_MARKER]) return ghostFactory.previousFactory;
  return factory;
}

type WidgetCapableUi = ExtensionContext["ui"] & {
  setWidget?: (
    key: string,
    value: string[] | undefined,
    options?: { placement?: string },
  ) => void;
  setStatus?: (key: string, value: string | undefined) => void;
};

function printOllamaCheckOutput(
  ctx: ExtensionContext,
  result: { ok: boolean; lines: string[] },
): void {
  const status = result.ok ? "passed" : "failed";
  ctx.ui.notify([...result.lines, `status: ${status}`].join("\n"), result.ok ? "info" : "warning");
}

function setGhostWidget(ctx: ExtensionContext, key: string, lines: string[]): void {
  const ui = ctx.ui as WidgetCapableUi;
  if (typeof ui.setWidget === "function") {
    ui.setWidget(key, lines.length > 0 ? lines : undefined, {
      placement: "belowEditor",
    });
    return;
  }

  ui.setStatus?.(key, lines[0]);
}

function clearGhostWidget(ctx: ExtensionContext, key: string): void {
  const ui = ctx.ui as WidgetCapableUi;
  ui.setWidget?.(key, undefined);
  ui.setStatus?.(key, undefined);
}

function dimWithTheme(ctx: ExtensionContext, text: string): string {
  return ctx.ui.theme?.fg?.("dim", text) ?? text;
}

type PredictionControllerOptions = {
  config: GhostConfig;
  predictor: OllamaPredictor;
  getText: () => string;
  getBlockReason: () => string | null;
  debug: DebugLogger;
  onPrediction: (ghost: GhostState) => void;
};

class PredictionController {
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

class OllamaPredictor {
  constructor(private readonly config: GhostConfig) {}

  async predict(before: string, after: string, signal: AbortSignal): Promise<string> {
    return predictWithOllama(before, after, signal, this.config);
  }
}

async function predictWithOllama(
  before: string,
  after: string,
  signal: AbortSignal,
  config: GhostConfig,
): Promise<string> {
  const res = await fetch(`${config.ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify(buildGenerateRequest(before, after, config, config.maxTokens)),
  });

  if (!res.ok) {
    const body = await safeReadResponseText(res);
    throw new Error(`Ollama HTTP ${res.status}: ${previewForLine(body, 160)}`);
  }

  const json = (await res.json()) as OllamaGenerateResponse;
  if (typeof json.error === "string" && json.error.length > 0) {
    throw new Error(`Ollama error: ${previewForLine(json.error, 160)}`);
  }

  return typeof json.response === "string" ? json.response : "";
}

type OllamaGenerateRequest = {
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

function buildGenerateRequest(
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
    raw: promptMode === "qwen-fim",
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

function buildQwenFimPrompt(before: string, after = ""): string {
  return [
    "<|fim_prefix|>",
    before.slice(-2500),
    "<|fim_suffix|>",
    after.slice(0, 1000),
    "<|fim_middle|>",
  ].join("");
}

function buildInstructionPrompt(before: string, after = ""): string {
  const suffix = after.trim()
    ? `\n\nText after cursor:\n${after.slice(0, 1000)}`
    : "";

  return [
    "You are an autocomplete engine for a terminal prompt editor.",
    "Continue the text exactly where it stops.",
    "Return only the next text to append. Do not explain, quote, or repeat the input.",
    "",
    "Text before cursor:",
    before.slice(-2500),
    suffix,
    "",
    "Continuation:",
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

function getStopTokens(promptMode: ResolvedPromptMode): string[] {
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
    "\nText before cursor:",
    "\nText after cursor:",
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
};

async function runOllamaCheck(
  config: GhostConfig,
  promptArg: string,
): Promise<{ ok: boolean; lines: string[] }> {
  const lines = [
    "pi-ghost-vim Ollama check",
    `url: ${config.ollamaUrl}`,
    `model: ${config.model}`,
    `prompt mode: ${describePromptMode(config)}`,
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

function previewForLine(text: string, maxLength: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLength) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function stripPromptEcho(before: string, completion: string): string {
  let out = completion;

  if (out.startsWith(before)) {
    out = out.slice(before.length);
  }

  const leadingWhitespace = out.match(/^\s+/)?.[0] ?? "";
  if (leadingWhitespace && out.slice(leadingWhitespace.length).startsWith(before)) {
    out = leadingWhitespace + out.slice(leadingWhitespace.length + before.length).replace(/^\s+/, "");
  }

  const maxOverlap = Math.min(before.length, out.length, 1000);

  for (let len = maxOverlap; len > 0; len--) {
    const beforeSuffix = before.slice(-len);
    const outPrefix = out.slice(0, len);

    if (beforeSuffix === outPrefix) {
      return out.slice(len);
    }
  }

  return out;
}

function looksLikeChatResponse(text: string): boolean {
  const s = text.trim();

  return [
    /^i understand\b/i,
    /^i'?m sorry\b/i,
    /^sorry\b/i,
    /^please provide\b/i,
    /^could you\b/i,
    /^can you\b/i,
    /^sure\b/i,
    /^certainly\b/i,
    /^here(?:'s| is)\b/i,
    /^as an ai\b/i,
    /^i don'?t have enough context\b/i,
    /^to assist\b/i,
    /^the continuation\b/i,
    /^suggested continuation\b/i,
    /^the next text\b/i,
    /^here(?:'s| is) the continuation\b/i,
    /^continuation:/i,
    /^output:/i,
    /^assistant:/i,
  ].some((re) => re.test(s));
}

function cleanupCompletion(args: { before: string; raw: string }): string {
  const { before } = args;

  let out = args.raw
    .replace(/\r/g, "")
    .replace(/<\|im_start\|>/g, "")
    .replace(/<\|im_end\|>/g, "")
    .replace(/<\|endoftext\|>/g, "")
    .replace(/<\|fim_prefix\|>/g, "")
    .replace(/<\|fim_suffix\|>/g, "")
    .replace(/<\|fim_middle\|>/g, "")
    .replace(/<start_of_turn>/g, "")
    .replace(/<end_of_turn>/g, "")
    .replace(/^\s*\n+/, "");

  out = stripPromptEcho(before, out);

  out = out
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "")
    .replace(
      /^(Continuation:|Suggested continuation:|Output:|Assistant:|Text to append:)\s*/i,
      "",
    )
    .replace(/[ \t]+$/g, "");

  out = stripPromptEcho(before, out);

  if (!out.trim()) return "";
  if (looksLikeChatResponse(out)) return "";

  const firstParagraph = out.split(/\n\s*\n/)[0] ?? "";
  out = firstParagraph;

  if (out.length > 200) {
    out = out.slice(0, 200);
  }

  return out;
}

function shouldShowCompletion(completion: string): boolean {
  return getCompletionRejectionReason(completion) === null;
}

function getCompletionRejectionReason(completion: string): string | null {
  const s = completion.trim();

  if (!s) return "empty";
  if (s.length < 2) return "too-short";
  if (looksLikeChatResponse(s)) return "chat-like";

  const sentenceCount = (s.match(/[.!?]/g) ?? []).length;
  if (sentenceCount > 2) return "too-many-sentences";

  return null;
}

function debugText(text: string): string {
  return JSON.stringify(previewForLine(text, 160));
}

function takeNextChunk(s: string): { take: string; rest: string } {
  const match = s.match(/^(\s*)(\S+)/);

  if (!match) {
    return { take: s, rest: "" };
  }

  const take = match[1] + match[2];

  return {
    take,
    rest: s.slice(take.length),
  };
}

function getGhostSuppressionReason(text: string, minChars: number): string | null {
  const trimmedLength = text.trim().length;
  if (trimmedLength < minChars) return `min-chars ${trimmedLength}/${minChars}`;

  const lastToken = text.split(/\s+/).at(-1) ?? "";
  if (lastToken.startsWith("/")) return "slash-command-or-path-token";
  if (lastToken.startsWith("@")) return "mention-token";
  if (text.endsWith("/")) return "path-like-trailing-slash";
  if (/^(?:~\/|\.\.?\/)/.test(lastToken)) return "path-like-token";
  if (lastToken.includes("/")) return "path-like-token";

  return null;
}

function injectGhostAfterCursor(
  lines: string[],
  ghost: string,
  width: number,
  dim: (text: string) => string,
): string[] {
  const oneLineGhost = ghost.split("\n")[0] ?? "";
  if (!oneLineGhost) return lines;

  const markerLine = lines.findIndex((line) => line.includes(CURSOR_MARKER));
  if (markerLine === -1) return lines;

  const styledGhost = dim(oneLineGhost);
  const line = lines[markerLine]!;
  const markerIndex = line.indexOf(CURSOR_MARKER);
  const insertAt = findGhostInsertIndex(line, markerIndex);
  const injected = line.slice(0, insertAt) + styledGhost + line.slice(insertAt);
  const fitted =
    visibleWidth(injected.replaceAll(CURSOR_MARKER, "")) > width
      ? truncateToWidth(injected, width, "")
      : injected;

  return [
    ...lines.slice(0, markerLine),
    fitted,
    ...lines.slice(markerLine + 1),
  ];
}

function findGhostInsertIndex(line: string, markerIndex: number): number {
  const afterMarker = markerIndex + CURSOR_MARKER.length;

  if (line.startsWith(SOFTWARE_CURSOR_START, afterMarker)) {
    const contentStart = afterMarker + SOFTWARE_CURSOR_START.length;
    const reset = findFirstReset(line, contentStart);
    if (reset) return reset.index + reset.sequence.length;
  }

  return afterMarker;
}

function findFirstReset(
  line: string,
  startIndex: number,
): { index: number; sequence: (typeof SOFTWARE_CURSOR_RESETS)[number] } | null {
  let first: { index: number; sequence: (typeof SOFTWARE_CURSOR_RESETS)[number] } | null =
    null;

  for (const sequence of SOFTWARE_CURSOR_RESETS) {
    const index = line.indexOf(sequence, startIndex);
    if (index === -1) continue;
    if (!first || index < first.index) first = { index, sequence };
  }

  return first;
}

type AutocompleteModelCommandResult =
  | { action: "status" }
  | { action: "list" }
  | { action: "error"; message: string }
  | { action: "set"; model: string; promptMode: PromptMode };

type StoredModelSelection = {
  model: string;
  promptMode: PromptMode;
};

function parseAutocompleteModelCommand(
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

  if (last && isPromptMode(last)) {
    promptMode = last;
    sawPromptMode = true;
    parts.pop();
  }

  const modelArg = parts.join(" ").trim();
  if (!modelArg && sawPromptMode) {
    return { action: "set", model: current.model, promptMode };
  }

  if (!modelArg) {
    return {
      action: "error",
      message:
        "Usage: /autocomplete-model [model] [auto|qwen-fim|instruct]\nTry: /autocomplete-model gemma4:e2b",
    };
  }

  return {
    action: "set",
    model: resolveModelAlias(modelArg),
    promptMode,
  };
}

function formatAutocompleteModelStatus(config: GhostConfig): string[] {
  return [
    "pi-ghost-vim autocomplete model",
    `model: ${config.model}`,
    `prompt mode: ${describePromptMode(config)}`,
    `run command: ollama run ${config.model}`,
    "change: /autocomplete-model gemma4:e2b",
    "modes: auto, qwen-fim, instruct",
  ];
}

function formatKnownModelPresets(): string[] {
  return [
    "pi-ghost-vim known model presets",
    ...KNOWN_MODEL_PRESETS.map(
      (preset) =>
        `${preset.model} — ${preset.label}; mode=${preset.promptMode}; ${preset.runCommand}`,
    ),
    "You can also pass any Ollama model name.",
  ];
}

function resolveModelAlias(model: string): string {
  const normalized = model.trim();
  const lower = normalized.toLowerCase();

  if (lower === "qwen") return "qwen2.5-coder:1.5b";
  if (lower === "gemma") return "gemma4:e2b";

  return normalized;
}

function describePromptMode(config: GhostConfig): string {
  const resolved = resolvePromptMode(config);
  return config.promptMode === "auto" ? `${resolved} (auto)` : resolved;
}

function resolvePromptMode(config: GhostConfig): ResolvedPromptMode {
  if (config.promptMode !== "auto") return config.promptMode;

  const model = config.model.toLowerCase();
  if (/qwen(?:2\.5|3)?[-_:]?coder/.test(model) || /qwen.*code/.test(model)) {
    return "qwen-fim";
  }

  return "instruct";
}

function isPromptMode(value: string): value is PromptMode {
  return (PROMPT_MODES as readonly string[]).includes(value);
}

function readPromptMode(value: string | undefined): PromptMode {
  if (!value) return DEFAULT_PROMPT_MODE;
  const normalized = value.trim().toLowerCase();
  return isPromptMode(normalized) ? normalized : DEFAULT_PROMPT_MODE;
}

function replaceConfig(target: GhostConfig, source: GhostConfig): void {
  Object.assign(target, source);
}

function applyStoredModelSelection(
  config: GhostConfig,
  selection: StoredModelSelection | null,
): void {
  if (!selection) return;
  config.model = selection.model;
  config.promptMode = selection.promptMode;
}

function readStoredModelSelection(ctx: ExtensionContext): StoredModelSelection | null {
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

function parseStoredModelSelection(data: unknown): StoredModelSelection | null {
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

function readConfigFromEnv(): GhostConfig {
  return {
    model: process.env.PI_GHOST_MODEL ?? DEFAULT_MODEL,
    promptMode: readPromptMode(process.env.PI_GHOST_PROMPT_MODE),
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
  };
}


function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
