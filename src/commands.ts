import type {
  ExtensionAPI,
  ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { getAcArgumentCompletions } from "./ac-completion.js";
import {
  DEFAULT_ALIASES,
  deleteModelAlias,
  getAliasesForModel,
  getCustomAliasEntries,
  loadAliases,
  resetAliasesForModel,
  saveAliases,
  setModelAlias
} from "./aliases.js";
import { describePromptMode, saveActiveModel, saveDefaultModel } from "./config.js";
import {
  DEBUG_WIDGET_KEY,
  KNOWN_MODEL_PRESETS,
  MODEL_SELECTION_ENTRY_TYPE
} from "./constants.js";
import { getDebugTraceFile } from "./debug-trace.js";
import { TRACE_FILE_PREFIX } from "./trace-schema.js";
import { getDailyTraceFile } from "./trace-writer.js";
import type { GhostVimWrapper } from "./editor-wrapper.js";
import {
  formatAutocompleteModelStatus,
  parseAutocompleteModelCommand
} from "./model-command.js";
import { runOllamaStatus } from "./ollama.js";
import type { DebugTraceDetails, GhostConfig } from "./types.js";
import {
  clearGhostWidget,
  printOllamaStatusOutput,
  setGhostWidget
} from "./ui.js";

export type DebugState = {
  enabled: boolean;
  history: string[];
};

export type RegisterAutocompleteCommandsOptions = {
  pi: ExtensionAPI;
  config: GhostConfig;
  wrappers: Set<GhostVimWrapper>;
  debugState: DebugState;
  emitDebug?: (
    ctx: ExtensionContext,
    message: string,
    details?: DebugTraceDetails
  ) => void;
  onDebugStateChanged?: (enabled: boolean) => void;
};

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

export function registerAutocompleteCommands({
  pi,
  config,
  wrappers,
  debugState,
  emitDebug,
  onDebugStateChanged
}: RegisterAutocompleteCommandsOptions): void {
  loadAliases();

  const showAcHelp = (ctx: ExtensionContext) => {
    ctx.ui.notify(
      [
        "=== Autocomplete Command Help ===",
        "Usage: /ac <subcommand> [args]",
        "",
        "Subcommands:",
        "  /ac model [<model>] [<mode>]  Change model & prompt mode (auto|qwen-fim|instruct|lfm-prefill)",
        "  /ac model default <model> [<mode>] Update default model & prompt mode",
        "  /ac model list                Display all supported models, presets & aliases as a report",
        "  /ac status                    Verify Ollama connection and report active model",
        "  /ac debug [on|off]            Toggle debug widget and verbose event tracing",
        "  /ac alias add <model> <alias> Add a custom alias for a model",
        "  /ac alias list [<model>]      List aliases for a model (or all aliases if omitted)",
        "  /ac alias delete <model> <alias> Delete a specific alias for a model",
        "  /ac alias reset <model>       Delete all aliases for a model",
        "  /ac help                      Show this help message"
      ].join("\n"),
      "info"
    );
  };

  const parseToggle = (arg: string): boolean | null => {
    if (["on", "1", "true", "yes", "enable", "enabled"].includes(arg)) return true;
    if (["off", "0", "false", "no", "disable", "disabled"].includes(arg)) return false;
    return null;
  };

  const handleAcDebug: CommandHandler = async (subArgs, ctx) => {
    const arg = subArgs.trim().toLowerCase();
    let nextEnabled: boolean;

    const toggle = parseToggle(arg);
    if (toggle !== null) {
      nextEnabled = toggle;
    } else if (!arg) {
      nextEnabled = !debugState.enabled;
    } else {
      ctx.ui.notify(
        "Invalid argument for debug. Usage: /ac debug [on|off]",
        "warning"
      );
      return;
    }

    if (!nextEnabled) {
      emitDebug?.(ctx, "debug: disabled", {
        event: "debug-disabled",
        debugFile: getDebugTraceFile(config),
        fileOnly: true
      });
      debugState.enabled = false;
      debugState.history.length = 0;
      clearGhostWidget(ctx, DEBUG_WIDGET_KEY);
      onDebugStateChanged?.(false);
      ctx.ui.notify("pi-ghost-vim debug disabled", "info");
      return;
    }

    debugState.enabled = true;
    debugState.history.length = 0;
    const debugFile = getDebugTraceFile(config);
    emitDebug?.(ctx, "debug: enabled", {
      event: "debug-enabled",
      debugFile,
      fileOnly: true
    });
    setGhostWidget(ctx, DEBUG_WIDGET_KEY, [
      "pi-ghost-vim debug enabled",
      `debug=${debugFile}`,
      `url=${config.ollamaUrl}`,
      `model=${config.model}`,
      `prompt=${describePromptMode(config)}`,
      `debounce=${config.debounceMs}ms timeout=${config.timeoutMs}ms minChars=${config.minChars}`
    ]);
    onDebugStateChanged?.(true);
    ctx.ui.notify(
      [
        `pi-ghost-vim debug enabled`,
        `debug file: ${debugFile}`,
        `trace file: ${getDailyTraceFile(config.traceDir, TRACE_FILE_PREFIX)}`
      ].join("\n"),
      "info"
    );
  };

  const formatModelReport = (): string[] => {
    const lines = [
      "=== Autocomplete Models Report ===",
      `Current Active Model: ${config.model} (${describePromptMode(config)})`,
      "",
      "--- Supported Presets ---",
      ...KNOWN_MODEL_PRESETS.map(
        (preset) =>
          `• ${preset.model} (${preset.label})
  - Mode: ${preset.promptMode}
  - Run: ${preset.runCommand}`
      ),
      "",
      "--- Configured Aliases ---"
    ];

    const aliasEntries = getCustomAliasEntries();
    if (aliasEntries.length > 0) {
      const grouped: Record<string, string[]> = {};
      for (const [alias, model] of aliasEntries) {
        if (!grouped[model]) grouped[model] = [];
        grouped[model].push(alias);
      }
      for (const [model, aliases] of Object.entries(grouped)) {
        lines.push(`• ${model}: aliases: ${aliases.join(", ")}`);
      }
    } else {
      lines.push(
        "No custom aliases defined. Add one using: /ac alias add <model> <alias>"
      );
    }

    lines.push("");
    lines.push("--- Default Aliases ---");
    for (const [alias, model] of Object.entries(DEFAULT_ALIASES)) {
      lines.push(`• ${alias} -> ${model}`);
    }

    lines.push("");
    lines.push(
      "You can pass any Ollama model name to `/ac model <model_name>`."
    );
    return lines;
  };

  const handleAcModel: CommandHandler = async (subArgs, ctx) => {
    const result = parseAutocompleteModelCommand(subArgs, config);

    if (result.action === "status") {
      ctx.ui.notify(formatAutocompleteModelStatus(config).join("\n"), "info");
      return;
    }

    if (result.action === "list") {
      ctx.ui.notify(formatModelReport().join("\n"), "info");
      return;
    }

    if (result.action === "error") {
      ctx.ui.notify(result.message, "warning");
      return;
    }

    if (result.action === "default") {
      config.model = result.model;
      config.promptMode = result.promptMode;
      saveDefaultModel(result.model, result.promptMode);

      pi.appendEntry(MODEL_SELECTION_ENTRY_TYPE, {
        model: config.model,
        promptMode: config.promptMode,
        updatedAt: Date.now()
      });

      for (const wrapper of wrappers) wrapper.handleConfigChanged();

      ctx.ui.notify(
        [
          "pi-ghost-vim default model updated",
          `default model: ${config.model}`,
          `prompt mode: ${describePromptMode(config)}`,
        ].join("\n"),
        "info"
      );
      return;
    }

    config.model = result.model;
    config.promptMode = result.promptMode;
    saveActiveModel(result.model, result.promptMode);

    pi.appendEntry(MODEL_SELECTION_ENTRY_TYPE, {
      model: config.model,
      promptMode: config.promptMode,
      updatedAt: Date.now()
    });

    for (const wrapper of wrappers) wrapper.handleConfigChanged();

    ctx.ui.notify(
      [
        "pi-ghost-vim model updated",
        `model: ${config.model}`,
        `prompt mode: ${describePromptMode(config)}`,
        `run command: ollama run ${config.model}`,
        "Use /ac status to validate it."
      ].join("\n"),
      "info"
    );
  };

  const handleAcAlias: CommandHandler = async (subArgs, ctx) => {
    const parts = subArgs.trim().split(/\s+/);
    const action = parts[0]?.toLowerCase();

    if (!action) {
      ctx.ui.notify(
        [
          "Usage for /ac alias:",
          "  /ac alias add <model> <alias>",
          "  /ac alias list [<model>]",
          "  /ac alias delete <model> <alias>",
          "  /ac alias reset <model>"
        ].join("\n"),
        "warning"
      );
      return;
    }

    switch (action) {
      case "add": {
        if (parts.length < 3) {
          ctx.ui.notify("Usage: /ac alias add <model> <alias>", "warning");
          return;
        }
        const alias = parts.at(-1)!;
        const model = parts.slice(1, -1).join(" ");
        setModelAlias(alias, model);
        saveAliases();
        ctx.ui.notify(`Alias added: ${alias} -> ${model}`, "info");
        break;
      }

      case "list": {
        const model = parts.slice(1).join(" ").trim();
        if (model) {
          const aliases = getAliasesForModel(model);
          if (aliases.length > 0) {
            ctx.ui.notify(
              `Aliases for ${model}:
${aliases.map((a) => `  • ${a}`).join("\n")}`,
              "info"
            );
          } else {
            ctx.ui.notify(`No aliases found for model: ${model}`, "info");
          }
        } else {
          const lines = ["=== Dynamic & Default Aliases ==="];
          const aliasEntries = getCustomAliasEntries();
          if (aliasEntries.length > 0) {
            lines.push("Custom Aliases:");
            for (const [alias, targetModel] of aliasEntries) {
              lines.push(`  • ${alias} -> ${targetModel}`);
            }
          } else {
            lines.push("No custom aliases configured.");
          }
          lines.push("Default Presets Aliases:");
          lines.push("  • qwen -> qwen2.5-coder:1.5b");
          lines.push("  • gemma -> gemma4:e2b");
          ctx.ui.notify(lines.join("\n"), "info");
        }
        break;
      }

      case "delete": {
        if (parts.length < 3) {
          ctx.ui.notify("Usage: /ac alias delete <model> <alias>", "warning");
          return;
        }
        const aliasToDelete = parts.at(-1)!.toLowerCase();
        const model = parts.slice(1, -1).join(" ").toLowerCase();
        const existingModel = deleteModelAlias(model, aliasToDelete);

        if (existingModel) {
          saveAliases();
          ctx.ui.notify(
            `Alias deleted: ${aliasToDelete} for model ${existingModel}`,
            "info"
          );
        } else {
          ctx.ui.notify(
            `No custom alias '${aliasToDelete}' found mapping to model '${model}'`,
            "warning"
          );
        }
        break;
      }

      case "reset": {
        if (parts.length < 2) {
          ctx.ui.notify("Usage: /ac alias reset <model>", "warning");
          return;
        }
        const modelToReset = parts.slice(1).join(" ").toLowerCase();
        const count = resetAliasesForModel(modelToReset);
        if (count > 0) {
          saveAliases();
          ctx.ui.notify(
            `Deleted all ${count} aliases for model: ${modelToReset}`,
            "info"
          );
        } else {
          ctx.ui.notify(
            `No custom aliases found for model: ${modelToReset}`,
            "info"
          );
        }
        break;
      }

      default:
        ctx.ui.notify(
          `Unknown alias action: ${action}. Supported: add, list, delete, reset`,
          "warning"
        );
        break;
    }
  };

  const handleAcStatus: CommandHandler = async (args, ctx) => {
    ctx.ui.notify("pi-ghost-vim: checking Ollama status...", "info");
    const result = await runOllamaStatus(config, args.trim());
    printOllamaStatusOutput(ctx, result);
  };

  pi.registerCommand("ac", {
    description:
      "Autocomplete commands. Usage: /ac [model|status|debug|alias|help]",
    getArgumentCompletions: getAcArgumentCompletions,
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        showAcHelp(ctx);
        return;
      }

      const parts = trimmed.split(/\s+/);
      const subcommand = parts[0].toLowerCase();
      const subcommandArgs = parts.slice(1).join(" ");

      switch (subcommand) {
        case "model":
          await handleAcModel(subcommandArgs, ctx);
          break;
        case "status":
          await handleAcStatus(subcommandArgs, ctx);
          break;
        case "debug":
          await handleAcDebug(subcommandArgs, ctx);
          break;
        case "alias":
          await handleAcAlias(subcommandArgs, ctx);
          break;
        case "help":
        default:
          showAcHelp(ctx);
          break;
      }
    }
  });
}
