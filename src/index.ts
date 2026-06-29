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
import {
  GhostVimWrapper,
  unwrapGhostFactory,
  type GhostEditorFactory,
} from "./editor-wrapper.js";
import { clearGhostWidget, dimWithTheme, setGhostWidget } from "./ui.js";
import type { EditorFactory, GhostBaseEditor } from "./types.js";

export default function ghostVim(pi: ExtensionAPI): void {
  let vimMode = "insert";
  const config = readConfigFromEnv();
  const debugState: DebugState = {
    enabled: config.debug,
    history: [],
  };
  const wrappers = new Set<GhostVimWrapper>();

  const disposeWrappers = () => {
    for (const wrapper of wrappers) wrapper.dispose();
    wrappers.clear();
  };

  const debug = (ctx: ExtensionContext, message: string) => {
    if (!debugState.enabled) return;

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
