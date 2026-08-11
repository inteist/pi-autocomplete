import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { getAliasesForModel, getCustomAliasEntries } from "./aliases.js";
import { KNOWN_MODEL_PRESETS } from "./constants.js";

type CompletionCandidate = { value: string; label: string; description: string };

/** Model suggestions, kept in sync with the presets rather than duplicated per subcommand. */
function presetModelCandidates(): CompletionCandidate[] {
  return KNOWN_MODEL_PRESETS.map((preset) => ({
    value: preset.model,
    label: preset.model,
    description: preset.label,
  }));
}

export function getAcArgumentCompletions(prefix: string): AutocompleteItem[] | null {
  const tokens: string[] = [];
  let currentToken = "";
  for (let i = 0; i < prefix.length; i++) {
    const char = prefix[i];
    if (/\s/.test(char)) {
      if (currentToken || tokens.length > 0) {
        if (currentToken) {
          tokens.push(currentToken);
          currentToken = "";
        }
      }
    } else {
      currentToken += char;
    }
  }
  tokens.push(currentToken);

  if (tokens.length === 1) {
    const subcommands = [
      {
        value: "model",
        label: "model",
        description: "Change model & prompt mode"
      },
      {
        value: "status",
        label: "status",
        description: "Verify Ollama connection"
      },
      {
        value: "debug",
        label: "debug",
        description: "Toggle debug widget & tracing"
      },
      {
        value: "alias",
        label: "alias",
        description: "Manage custom model aliases"
      },
      { value: "help", label: "help", description: "Show help message" }
    ];
    const val = tokens[0].toLowerCase();
    const filtered = subcommands.filter((s) => s.value.startsWith(val));
    return filtered.length > 0 ? filtered : null;
  }

  const subcommand = tokens[0].toLowerCase();
  const subArgs = tokens.slice(1);

  if (subcommand === "model") {
    if (subArgs.length === 1) {
      const candidates: CompletionCandidate[] = [
        {
          value: "list",
          label: "list",
          description: "Display all supported models, presets & aliases"
        },
        ...presetModelCandidates(),
        {
          value: "qwen",
          label: "qwen",
          description: "Alias for qwen2.5-coder:1.5b"
        },
        {
          value: "gemma",
          label: "gemma",
          description: "Alias for gemma4:e4b"
        },
        {
          value: "lfm",
          label: "lfm",
          description: "Alias for LFM25:2.6b"
        }
      ];
      const customAliasEntries = getCustomAliasEntries();
      for (const [alias, model] of customAliasEntries) {
        candidates.push({
          value: alias,
          label: alias,
          description: `Custom alias for ${model}`
        });
      }
      const val = subArgs[0].toLowerCase();
      const filtered = candidates
        .filter((c) => c.value.toLowerCase().startsWith(val))
        .map((c) => ({
          value: `model ${c.value}`,
          label: c.label,
          description: c.description
        }));
      return filtered.length > 0 ? filtered : null;
    }

    if (subArgs.length === 2) {
      if (subArgs[0].toLowerCase() === "list") return null;
      const modelArg = subArgs[0];
      const val = subArgs[1].toLowerCase();
      const modes = [
        {
          value: "auto",
          label: "auto",
          description: "Automatic prompt mode selection"
        },
        {
          value: "qwen-fim",
          label: "qwen-fim",
          description: "Qwen FIM mode"
        },
        {
          value: "instruct",
          label: "instruct",
          description: "Instruction continuation mode"
        },
        {
          value: "lfm-prefill",
          label: "lfm-prefill",
          description: "LFM2.5 assistant-prefill continuation mode"
        }
      ];
      const filtered = modes
        .filter((m) => m.value.startsWith(val))
        .map((m) => ({
          value: `model ${modelArg} ${m.value}`,
          label: m.label,
          description: m.description
        }));
      return filtered.length > 0 ? filtered : null;
    }
  }

  if (subcommand === "debug") {
    if (subArgs.length === 1) {
      const val = subArgs[0].toLowerCase();
      const options = [
        {
          value: "on",
          label: "on",
          description: "Enable debug widget & tracing"
        },
        {
          value: "off",
          label: "off",
          description: "Disable debug widget & tracing"
        }
      ];
      const filtered = options
        .filter((o) => o.value.startsWith(val))
        .map((o) => ({
          value: `debug ${o.value}`,
          label: o.label,
          description: o.description
        }));
      return filtered.length > 0 ? filtered : null;
    }
  }

  if (subcommand === "alias") {
    if (subArgs.length === 1) {
      const val = subArgs[0].toLowerCase();
      const actions = [
        {
          value: "add",
          label: "add",
          description: "Add a custom alias for a model"
        },
        {
          value: "list",
          label: "list",
          description: "List aliases for a model (or all aliases)"
        },
        {
          value: "delete",
          label: "delete",
          description: "Delete a specific alias for a model"
        },
        {
          value: "reset",
          label: "reset",
          description: "Delete all aliases for a model"
        }
      ];
      const filtered = actions
        .filter((a) => a.value.startsWith(val))
        .map((a) => ({
          value: `alias ${a.value}`,
          label: a.label,
          description: a.description
        }));
      return filtered.length > 0 ? filtered : null;
    }

    if (subArgs.length > 1) {
      const action = subArgs[0].toLowerCase();
      if (action === "add" && subArgs.length === 2) {
        const val = subArgs[1].toLowerCase();
        const models = presetModelCandidates();
        const filtered = models
          .filter((m) => m.value.toLowerCase().startsWith(val))
          .map((m) => ({
            value: `alias add ${m.value}`,
            label: m.label,
            description: m.description
          }));
        return filtered.length > 0 ? filtered : null;
      }

      if (action === "list" && subArgs.length === 2) {
        const val = subArgs[1].toLowerCase();
        const models = presetModelCandidates();
        const filtered = models
          .filter((m) => m.value.toLowerCase().startsWith(val))
          .map((m) => ({
            value: `alias list ${m.value}`,
            label: m.label,
            description: m.description
          }));
        return filtered.length > 0 ? filtered : null;
      }

      if (action === "delete") {
        if (subArgs.length === 2) {
          const val = subArgs[1].toLowerCase();
          const customAliasEntries = getCustomAliasEntries();
          const uniqueModels = [
            ...new Set(customAliasEntries.map(([_, m]) => m))
          ];
          const filtered = uniqueModels
            .filter((m) => m.toLowerCase().startsWith(val))
            .map((m) => ({
              value: `alias delete ${m}`,
              label: m,
              description: `Delete alias for model ${m}`
            }));
          return filtered.length > 0 ? filtered : null;
        }
        if (subArgs.length === 3) {
          const model = subArgs[1];
          const val = subArgs[2].toLowerCase();
          const aliases = getAliasesForModel(model);
          const filtered = aliases
            .filter((a) => a.toLowerCase().startsWith(val))
            .map((a) => ({
              value: `alias delete ${model} ${a}`,
              label: a,
              description: `Delete alias '${a}' mapping to ${model}`
            }));
          return filtered.length > 0 ? filtered : null;
        }
      }

      if (action === "reset" && subArgs.length === 2) {
        const val = subArgs[1].toLowerCase();
        const customAliasEntries = getCustomAliasEntries();
        const uniqueModels = [
          ...new Set(customAliasEntries.map(([_, m]) => m))
        ];
        const filtered = uniqueModels
          .filter((m) => m.toLowerCase().startsWith(val))
          .map((m) => ({
            value: `alias reset ${m}`,
            label: m,
            description: `Reset all custom aliases for ${m}`
          }));
        return filtered.length > 0 ? filtered : null;
      }
    }
  }

  return null;
}
