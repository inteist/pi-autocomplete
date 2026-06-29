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

const DEFAULT_MODEL = "qwen2.5-coder:1.5b";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_KEEP_ALIVE = "30m";
const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

const DEBUG_WIDGET_KEY = "pi-ghost-vim-debug";
const GHOST_FACTORY_MARKER = Symbol.for("pi-ghost-vim.editorFactory");

const SOFTWARE_CURSOR_START = "\x1b[7m";
const SOFTWARE_CURSOR_RESETS = ["\x1b[0m", "\x1b[27m"] as const;

type GhostConfig = {
  model: string;
  ollamaUrl: string;
  keepAlive: string;
  debounceMs: number;
  timeoutMs: number;
  checkTimeoutMs: number;
  doubleTabMs: number;
  minChars: number;
  maxPrefixChars: number;
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

  pi.registerCommand("ghost-vim-debug", {
    description: "Toggle pi-ghost-vim debug logging (usage: /ghost-vim-debug [on|off])",
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

      const config = readConfigFromEnv();
      debugHistory.length = 0;
      setGhostWidget(ctx, DEBUG_WIDGET_KEY, [
        "pi-ghost-vim debug enabled",
        `url=${config.ollamaUrl}`,
        `model=${config.model}`,
        `debounce=${config.debounceMs}ms timeout=${config.timeoutMs}ms minChars=${config.minChars}`,
      ]);
      ctx.ui.notify("pi-ghost-vim debug enabled", "info");
    },
  });

  pi.registerCommand("ghost-vim-check", {
    description: "Check pi-ghost-vim Ollama connectivity and configured model",
    handler: async (args, ctx) => {
      const config = readConfigFromEnv();
      ctx.ui.notify("pi-ghost-vim: checking Ollama...", "info");
      const result = await runOllamaCheck(config, args.trim());
      setGhostWidget(ctx, DEBUG_WIDGET_KEY, result.lines);
      ctx.ui.notify(
        result.ok ? "pi-ghost-vim: Ollama check passed" : "pi-ghost-vim: Ollama check failed",
        result.ok ? "info" : "warning",
      );
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

    const config = readConfigFromEnv();
    debugEnabled = debugEnabled || config.debug;
    debug(ctx, `session_start model=${config.model} url=${config.ollamaUrl}`);

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
      this.opts.debug(`request #${requestId}: start`);
      const prediction = await this.opts.predictor.predict(baseText, controller.signal);
      const elapsed = Date.now() - startedAt;

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
      if (!prediction.trim()) {
        this.opts.debug(`drop #${requestId}: empty response after ${elapsed}ms`);
        return;
      }

      this.opts.debug(
        `show #${requestId}: ${prediction.length} chars after ${elapsed}ms`,
      );
      this.opts.onPrediction({
        baseText,
        text: prediction,
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

  async predict(text: string, signal: AbortSignal): Promise<string> {
    return predictWithOllama(text, signal, this.config);
  }
}

async function predictWithOllama(
  text: string,
  signal: AbortSignal,
  config: GhostConfig,
): Promise<string> {
  const res = await fetch(`${config.ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      model: config.model,
      prompt: text.slice(-config.maxPrefixChars),
      stream: false,
      keep_alive: config.keepAlive,
      options: {
        temperature: 0,
        top_p: 0.9,
        num_predict: config.maxTokens,
        num_ctx: 4096,
        stop: ["\n\n\n"],
      },
    }),
  });

  if (!res.ok) {
    const body = await safeReadResponseText(res);
    throw new Error(`Ollama HTTP ${res.status}: ${previewForLine(body, 160)}`);
  }

  const json = (await res.json()) as { response?: string };
  return cleanupPrediction(json.response ?? "");
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
    }
  } catch (error) {
    lines.push(`tags: ${formatError(error)}`);
  }

  const prompt = promptArg || "Return exactly: ready";
  try {
    const startedAt = Date.now();
    const generateRes = await fetchWithTimeout(
      `${config.ollamaUrl}/api/generate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          prompt,
          stream: false,
          keep_alive: config.keepAlive,
          options: {
            temperature: 0,
            num_predict: Math.min(config.maxTokens, 24),
            num_ctx: 2048,
          },
        }),
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

    const response = typeof json.response === "string" ? json.response.trim() : "";
    lines.push(`generate: ok after ${elapsed}ms`);
    lines.push(`response: ${previewForLine(response || "(empty)", 240)}`);
    return { ok: response.length > 0, lines };
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

function cleanupPrediction(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/^\s*\n+/, "")
    .replace(/[ \t]+$/g, "")
    .slice(0, 500);
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

function shouldSuppressGhost(text: string, minChars: number): boolean {
  return getGhostSuppressionReason(text, minChars) !== null;
}

function getGhostSuppressionReason(text: string, minChars: number): string | null {
  const trimmedLength = text.trim().length;
  if (trimmedLength < minChars) return `min-chars ${trimmedLength}/${minChars}`;

  const lastToken = text.split(/\s+/).at(-1) ?? "";
  if (lastToken.startsWith("/")) return "slash-command-or-path-token";
  if (lastToken.startsWith("@")) return "mention-token";
  if (text.endsWith("/")) return "path-like-trailing-slash";

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

function readConfigFromEnv(): GhostConfig {
  return {
    model: process.env.PI_GHOST_MODEL ?? DEFAULT_MODEL,
    ollamaUrl: normalizeBaseUrl(
      process.env.PI_GHOST_OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
    ),
    keepAlive: process.env.PI_GHOST_KEEP_ALIVE ?? DEFAULT_KEEP_ALIVE,
    debounceMs: envNumber("PI_GHOST_DEBOUNCE_MS", 250),
    timeoutMs: envNumber("PI_GHOST_TIMEOUT_MS", 2500),
    checkTimeoutMs: envNumber("PI_GHOST_CHECK_TIMEOUT_MS", DEFAULT_CHECK_TIMEOUT_MS),
    doubleTabMs: envNumber("PI_GHOST_DOUBLE_TAB_MS", 350),
    minChars: envNumber("PI_GHOST_MIN_CHARS", 8),
    maxPrefixChars: envNumber("PI_GHOST_MAX_PREFIX_CHARS", 2500),
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
