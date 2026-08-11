import { getAgentDir } from "@earendil-works/pi-coding-agent";
import fs from "fs";
import path from "path";

/**
 * Built-in aliases (alias -> model), the single source of truth for alias resolution,
 * alias listings and `/ac` argument completion.
 */
export const DEFAULT_ALIASES: Readonly<Record<string, string>> = {
  qwen: "qwen2.5-coder:1.5b",
  gemma: "gemma4:e4b",
  lfm: "LFM25:2.6b",
};

let customAliases: Record<string, string> = {};

export function getAliasesFilePath(): string {
  return path.join(getAgentDir(), "autocomplete-aliases.json");
}

export function loadAliases(): void {
  customAliases = {};

  try {
    const filePath = getAliasesFilePath();
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content) as { aliases?: unknown };
    if (!parsed.aliases || typeof parsed.aliases !== "object") return;

    for (const [alias, model] of Object.entries(parsed.aliases)) {
      if (typeof model !== "string") continue;
      const normalizedAlias = alias.trim().toLowerCase();
      const normalizedModel = model.trim();
      if (!normalizedAlias || !normalizedModel) continue;
      customAliases[normalizedAlias] = normalizedModel;
    }
  } catch {
    customAliases = {};
  }
}

export function saveAliases(): void {
  try {
    const filePath = getAliasesFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      filePath,
      JSON.stringify({ aliases: customAliases }, null, 2),
      "utf-8",
    );
  } catch {
    // Ignore persistence failures; commands still update in-memory aliases.
  }
}

export function getCustomAliasEntries(): Array<[alias: string, model: string]> {
  return Object.entries(customAliases);
}

export function setModelAlias(alias: string, model: string): void {
  customAliases[alias.trim().toLowerCase()] = model.trim();
}

export function deleteModelAlias(model: string, alias: string): string | null {
  const aliasKey = alias.trim().toLowerCase();
  const expectedModel = model.trim().toLowerCase();
  const existingModel = customAliases[aliasKey];

  if (existingModel && existingModel.toLowerCase() === expectedModel) {
    delete customAliases[aliasKey];
    return existingModel;
  }

  return null;
}

export function resetAliasesForModel(modelName: string): number {
  const target = modelName.trim().toLowerCase();
  let count = 0;

  for (const [alias, model] of Object.entries(customAliases)) {
    if (model.toLowerCase() === target) {
      delete customAliases[alias];
      count++;
    }
  }

  return count;
}

export function getAliasesForModel(modelName: string): string[] {
  const target = modelName.trim().toLowerCase();
  const results: string[] = [];

  for (const [alias, model] of Object.entries(DEFAULT_ALIASES)) {
    if (model.toLowerCase() === target) {
      results.push(alias);
    }
  }

  for (const [alias, model] of Object.entries(customAliases)) {
    if (model.toLowerCase() === target) {
      results.push(alias);
    }
  }
  return [...new Set(results)];
}

export function resolveModelAlias(model: string): string {
  const normalized = model.trim();
  const lower = normalized.toLowerCase();

  if (customAliases[lower]) {
    return customAliases[lower];
  }

  if (DEFAULT_ALIASES[lower]) {
    return DEFAULT_ALIASES[lower];
  }

  return normalized;
}
