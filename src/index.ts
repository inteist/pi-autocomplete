import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DEBUG_WIDGET_KEY, GHOST_FACTORY_MARKER } from "./constants.js";
import {
  applyStoredModelSelection,
  describePromptMode,
  readConfigFromEnv,
  readStoredModelSelection,
  replaceConfig,
} from "./config.js";
import { registerAutocompleteCommands, type DebugState } from "./commands.js";
import { DebugTraceWriter } from "./debug-trace.js";
import { TraceRecorder } from "./trace-recorder.js";
import {
  GhostVimWrapper,
  unwrapGhostFactory,
  type GhostEditorFactory,
} from "./editor-wrapper.js";
import { clearGhostWidget, dimWithTheme, setGhostWidget } from "./ui.js";
import type {
  DebugTraceDetails,
  EditorFactory,
  GhostBaseEditor,
} from "./types.js";

export default function ghostVim(pi: ExtensionAPI): void {
  let vimMode = "insert";
  const config = readConfigFromEnv();
  const debugState: DebugState = {
    enabled: config.debug,
    history: [],
  };
  const wrappers = new Set<GhostVimWrapper>();
  const recorder = new TraceRecorder(config);
  let sessionTraceWriter: DebugTraceWriter | null = null;

  const disposeWrappers = () => {
    for (const wrapper of wrappers) wrapper.dispose();
    wrappers.clear();
  };

  const debug = (ctx: ExtensionContext, message: string, details?: DebugTraceDetails) => {
    if (!debugState.enabled) return;

    if (!sessionTraceWriter) {
      sessionTraceWriter = new DebugTraceWriter(config, recorder.sessionId);
    }
    sessionTraceWriter.write(message, details);

    if (details?.fileOnly) return;

    const time = new Date().toLocaleTimeString();
    const line = dimWithTheme(ctx, `[${time}] ${message}`);
    debugState.history.push(line);
    while (debugState.history.length > 8) debugState.history.shift();
    setGhostWidget(ctx, DEBUG_WIDGET_KEY, debugState.history);
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

  registerAutocompleteCommands({
    pi,
    config,
    wrappers,
    debugState,
    emitDebug: debug,
    onDebugStateChanged: (enabled) => {
      if (!enabled) {
        sessionTraceWriter?.close();
        sessionTraceWriter = null;
      }
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
    debugState.enabled = debugState.enabled || config.debug;
    debug(ctx, `session_start model=${config.model} prompt=${describePromptMode(config)} url=${config.ollamaUrl}`, {
      event: "session-start",
      sessionId: recorder.sessionId,
      trace: config.trace,
      traceFile: recorder.currentFile(),
    });

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
        recorder,
        debug: (message, details) => debug(ctx, message, details),
        isDebugEnabled: () => debugState.enabled,
      });
      wrappers.add(wrapper);
      return wrapper;
    }) as GhostEditorFactory;

    factory[GHOST_FACTORY_MARKER] = true;
    factory.previousFactory = previousFactory;
    ctx.ui.setEditorComponent(factory);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    // Disposing the wrappers first flushes any suggestion still waiting for an outcome.
    disposeWrappers();
    debug(ctx, "session_shutdown", { event: "session-shutdown", fileOnly: true });
    sessionTraceWriter?.close();
    sessionTraceWriter = null;
    clearGhostWidget(ctx, DEBUG_WIDGET_KEY);
  });
}
