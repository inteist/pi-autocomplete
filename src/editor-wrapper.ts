import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type AutocompleteProvider,
  type EditorComponent,
  type Focusable,
} from "@earendil-works/pi-tui";
import { GHOST_FACTORY_MARKER } from "./constants.js";
import { debugText, takeNextChunk } from "./completion.js";
import { describePromptMode } from "./config.js";
import { injectGhostAfterCursor } from "./inline-ghost.js";
import { OllamaPredictor, PredictionController } from "./prediction-controller.js";
import type {
  ActionHandler,
  DebugTraceDetails,
  EditorFactory,
  ExtensionShortcutHandler,
  GhostBaseEditor,
  GhostState,
  GhostWrapperOptions,
} from "./types.js";

export type GhostEditorFactory = EditorFactory & {
  [GHOST_FACTORY_MARKER]?: true;
  previousFactory?: EditorFactory;
};

export class GhostVimWrapper implements EditorComponent, Focusable {
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
      debug: (message, details) => this.opts.debug(message, details),
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
    if (this.shouldTraceFileOnly()) {
      this.traceFileOnly("input: received", {
        event: "editor-input",
        input: data,
        inputPreview: debugText(data),
        mode: this.getMode(),
        textLength: this.getText().length,
        hasGhost: !!this.ghost,
      });
    }

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
      this.traceFileOnly("input: text changed", {
        event: "editor-text-change",
        input: data,
        beforeLength: before.length,
        afterLength: after.length,
        before,
        after,
      });
      this.schedulePrediction(after);
    } else {
      this.traceFileOnly("input: no text change", {
        event: "editor-no-text-change",
        input: data,
        textLength: after.length,
      });
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
      {
        event: "config-changed",
        model: this.opts.config.model,
        promptMode: this.opts.config.promptMode,
        promptModeDescription: describePromptMode(this.opts.config),
        ollamaUrl: this.opts.config.ollamaUrl,
        debounceMs: this.opts.config.debounceMs,
        timeoutMs: this.opts.config.timeoutMs,
        minChars: this.opts.config.minChars,
        maxTokens: this.opts.config.maxTokens,
      },
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
      this.opts.debug("accept: whole ghost via double-tab", {
        event: "ghost-accept-double-tab",
        ghostLength: this.ghost?.text.length ?? 0,
      });
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
    this.opts.debug(`accept: chunk ${take.length} chars, rest=${rest.length}`, {
      event: "ghost-accept-chunk",
      takeLength: take.length,
      restLength: rest.length,
      take,
      rest,
    });
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

    this.opts.debug(`accept: whole ${this.ghost.text.length} chars`, {
      event: "ghost-accept-whole",
      ghostLength: this.ghost.text.length,
      ghostText: this.ghost.text,
    });
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
    if (this.ghost) {
      this.traceFileOnly(`clear: ghost #${this.ghost.requestId}`, {
        event: "ghost-clear",
        requestId: this.ghost.requestId,
        ghostLength: this.ghost.text.length,
        ghostText: this.ghost.text,
      });
    }
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

  private shouldTraceFileOnly(): boolean {
    return this.opts.isDebugEnabled?.() ?? true;
  }

  private traceFileOnly(message: string, details: DebugTraceDetails): void {
    if (!this.shouldTraceFileOnly()) return;
    this.opts.debug(message, { ...details, fileOnly: true });
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

export function unwrapGhostFactory(factory: EditorFactory | undefined): EditorFactory | undefined {
  const ghostFactory = factory as GhostEditorFactory | undefined;
  if (ghostFactory?.[GHOST_FACTORY_MARKER]) return ghostFactory.previousFactory;
  return factory;
}
