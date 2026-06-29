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

const SOFTWARE_CURSOR_START = "\x1b[7m";
const SOFTWARE_CURSOR_RESETS = ["\x1b[0m", "\x1b[27m"] as const;

type GhostConfig = {
  model: string;
  ollamaUrl: string;
  keepAlive: string;
  debounceMs: number;
  timeoutMs: number;
  doubleTabMs: number;
  minChars: number;
  maxPrefixChars: number;
  maxTokens: number;
  inline: boolean;
};

type GhostState = {
  baseText: string;
  text: string;
  requestId: number;
  createdAt: number;
};

type ModeProvider = () => string;

type GhostBaseEditor = EditorComponent &
  Partial<Focusable> & {
    dispose?: () => void;
    getMode?: () => string;
    getCursor?: () => { line: number; col: number };
    getLines?: () => string[];
    isShowingAutocomplete?: () => boolean;
  };

type GhostWrapperOptions = {
  ctx: ExtensionContext;
  tui: TUI;
  baseEditor: GhostBaseEditor;
  getExternalMode: ModeProvider;
  config: GhostConfig;
};

export default function ghostVim(pi: ExtensionAPI): void {
  let vimMode = "insert";
  const wrappers = new Set<GhostVimWrapper>();

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

  pi.on("session_start", (_event, ctx) => {
    const previousFactory = ctx.ui.getEditorComponent?.();

    if (!previousFactory) {
      ctx.ui.notify?.(
        "pi-ghost-vim: no existing custom editor found; load this after pi-vim",
        "warning",
      );
    }

    const config = readConfigFromEnv();

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const baseEditor = previousFactory
        ? previousFactory(tui, theme, keybindings)
        : new CustomEditor(tui, theme, keybindings);

      const wrapper = new GhostVimWrapper({
        ctx,
        tui,
        baseEditor: baseEditor as GhostBaseEditor,
        getExternalMode: () => vimMode,
        config,
      });
      wrappers.add(wrapper);
      return wrapper;
    });
  });

  pi.on("session_shutdown", () => {
    for (const wrapper of wrappers) wrapper.dispose();
    wrappers.clear();
  });
}

class GhostVimWrapper implements EditorComponent, Focusable {
  private ghost: GhostState | null = null;
  private lastTabAt = 0;
  private ownFocused = false;
  private disposed = false;
  private readonly predictions: PredictionController;

  constructor(private readonly opts: GhostWrapperOptions) {
    this.predictions = new PredictionController({
      config: opts.config,
      predictor: new OllamaPredictor(opts.config),
      getText: () => this.getText(),
      canShowPrediction: () => this.canShowGhostNow(),
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
    return (
      this.isInsertMode() &&
      this.isCursorAtEnd() &&
      !this.isNativeAutocompleteShowing()
    );
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

type PredictionControllerOptions = {
  config: GhostConfig;
  predictor: OllamaPredictor;
  getText: () => string;
  canShowPrediction: () => boolean;
  onPrediction: (ghost: GhostState) => void;
};

class PredictionController {
  private requestId = 0;
  private abort: AbortController | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: PredictionControllerOptions) {}

  schedule(baseText: string): void {
    const requestId = this.nextRequest();

    if (shouldSuppressGhost(baseText, this.opts.config.minChars)) return;
    if (!this.opts.canShowPrediction()) return;

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

    const timeout = setTimeout(() => controller.abort(), this.opts.config.timeoutMs);

    try {
      const prediction = await this.opts.predictor.predict(baseText, controller.signal);

      if (requestId !== this.requestId) return;
      if (this.opts.getText() !== baseText) return;
      if (!this.opts.canShowPrediction()) return;
      if (!prediction.trim()) return;

      this.opts.onPrediction({
        baseText,
        text: prediction,
        requestId,
        createdAt: Date.now(),
      });
    } catch {
      // Silent failure is best for typing-time autocomplete.
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

  if (!res.ok) return "";

  const json = (await res.json()) as { response?: string };
  return cleanupPrediction(json.response ?? "");
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
  const lastToken = text.split(/\s+/).at(-1) ?? "";

  return (
    text.trim().length < minChars ||
    lastToken.startsWith("/") ||
    lastToken.startsWith("@") ||
    text.endsWith("/")
  );
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
    timeoutMs: envNumber("PI_GHOST_TIMEOUT_MS", 900),
    doubleTabMs: envNumber("PI_GHOST_DOUBLE_TAB_MS", 350),
    minChars: envNumber("PI_GHOST_MIN_CHARS", 20),
    maxPrefixChars: envNumber("PI_GHOST_MAX_PREFIX_CHARS", 2500),
    maxTokens: envNumber("PI_GHOST_MAX_TOKENS", 48),
    inline: envBool("PI_GHOST_INLINE", true),
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
