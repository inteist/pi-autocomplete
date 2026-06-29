import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AutocompleteItem } from "@earendil-works/pi-tui";

import ghostVim from "../src/index.js";

type RegisteredCommand = {
  description?: string;
  getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
  handler: (args: string, ctx: MockContext) => void | Promise<void>;
};

type Notification = { message: string; level?: string };
type WidgetUpdate = { key: string; value: string[] | undefined; options?: unknown };

type MockContext = {
  ui: {
    notifications: Notification[];
    widgets: WidgetUpdate[];
    notify: (message: string, level?: string) => void;
    setWidget: (key: string, value: string[] | undefined, options?: unknown) => void;
    setStatus: (key: string, value: string | undefined) => void;
    theme: { fg: (style: string, text: string) => string };
    getEditorComponent?: () => unknown;
    setEditorComponent?: (component: unknown) => void;
  };
  sessionManager: {
    getBranch: () => unknown[];
    getEntries: () => unknown[];
  };
};

function createMockPi() {
  const commands = new Map<string, RegisteredCommand>();
  const sessionHandlers = new Map<string, Array<(event: unknown, ctx: MockContext) => void>>();
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];

  const pi = {
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    on(eventName: string, handler: (event: unknown, ctx: MockContext) => void) {
      const handlers = sessionHandlers.get(eventName) ?? [];
      handlers.push(handler);
      sessionHandlers.set(eventName, handlers);
    },
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ customType, data });
    },
    events: {
      on() {
        // The autocomplete extension listens to pi-vim mode events if available.
      },
    },
  };

  return { pi, commands, sessionHandlers, appendedEntries };
}

function createMockContext(): MockContext {
  const notifications: Notification[] = [];
  const widgets: WidgetUpdate[] = [];
  let editorComponent: unknown = undefined;

  return {
    ui: {
      notifications,
      widgets,
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
      setWidget(key: string, value: string[] | undefined, options?: unknown) {
        widgets.push({ key, value, options });
      },
      setStatus(key: string, value: string | undefined) {
        widgets.push({ key, value: value === undefined ? undefined : [value] });
      },
      theme: {
        fg: (_style: string, text: string) => text,
      },
      getEditorComponent() {
        return editorComponent;
      },
      setEditorComponent(component: unknown) {
        editorComponent = component;
      },
    },
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
    },
  };
}

function useTempAgentDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-autocomplete-test-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_GHOST_MODEL = "qwen2.5-coder:1.5b";
  return dir;
}

function cleanupTempAgentDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_GHOST_MODEL;
  delete process.env.PI_GHOST_DEBUG_FILE;
  delete process.env.PI_GHOST_TRACE_FILE;
  delete process.env.PI_GHOST_DEBUG_TRACE_FILE;
}

async function readFileEventually(filePath: string, needle: string): Promise<string> {
  for (let attempt = 0; attempt < 25; attempt++) {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf8");
      if (content.includes(needle)) return content;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.fail(`expected ${filePath} to contain ${needle}`);
}

function getAcCommand(commands: Map<string, RegisteredCommand>): RegisteredCommand {
  const command = commands.get("ac");
  assert.ok(command, "expected /ac command to be registered");
  return command;
}

function lastNotification(ctx: MockContext): Notification {
  const notification = ctx.ui.notifications.at(-1);
  assert.ok(notification, "expected a notification");
  return notification;
}

test("registers the unified /ac command and handles model status/update", async () => {
  const dir = useTempAgentDir();
  try {
    const { pi, commands, appendedEntries } = createMockPi();
    ghostVim(pi as never);

    assert.ok(commands.has("ac"));

    const command = getAcCommand(commands);
    const ctx = createMockContext();

    await command.handler("model", ctx);
    assert.match(lastNotification(ctx).message, /model: qwen2\.5-coder:1\.5b/);
    assert.match(lastNotification(ctx).message, /prompt mode: qwen-fim \(auto\)/);

    await command.handler("model gemma instruct", ctx);
    const gemmaEntry = appendedEntries.at(-1);
    assert.equal(gemmaEntry?.customType, "pi-ghost-vim-model");
    assert.deepEqual(
      {
        model: (gemmaEntry?.data as { model?: string }).model,
        promptMode: (gemmaEntry?.data as { promptMode?: string }).promptMode,
      },
      { model: "gemma4:e4b", promptMode: "instruct" },
    );
    assert.equal(typeof (gemmaEntry?.data as { updatedAt?: unknown }).updatedAt, "number");
    assert.match(lastNotification(ctx).message, /model: gemma4:e4b/);
    assert.match(lastNotification(ctx).message, /prompt mode: instruct/);

    await command.handler("model qwen", ctx);
    const entry = appendedEntries.at(-1)?.data as { model?: string; promptMode?: string };
    assert.equal(entry.model, "qwen2.5-coder:1.5b");
    assert.equal(entry.promptMode, "auto");

    await command.handler("model qwen fim", ctx);
    const qwenFimEntry = appendedEntries.at(-1)?.data as { model?: string; promptMode?: string };
    assert.equal(qwenFimEntry.model, "qwen2.5-coder:1.5b");
    assert.equal(qwenFimEntry.promptMode, "qwen-fim");

    await command.handler("model fim", ctx);
    const onlyFimEntry = appendedEntries.at(-1)?.data as { model?: string; promptMode?: string };
    assert.equal(onlyFimEntry.model, "qwen2.5-coder:1.5b");
    assert.equal(onlyFimEntry.promptMode, "qwen-fim");
  } finally {
    cleanupTempAgentDir(dir);
  }
});

test("/ac alias add/list/delete persists aliases and model resolution uses them", async () => {
  const dir = useTempAgentDir();
  try {
    const { pi, commands, appendedEntries } = createMockPi();
    ghostVim(pi as never);

    const command = getAcCommand(commands);
    const ctx = createMockContext();
    const alias = `unit-${Date.now()}`;

    await command.handler(`alias add starcoder2:3b ${alias}`, ctx);
    assert.match(lastNotification(ctx).message, new RegExp(`Alias added: ${alias} -> starcoder2:3b`));

    const aliasFile = path.join(dir, "autocomplete-aliases.json");
    const saved = JSON.parse(readFileSync(aliasFile, "utf8")) as { aliases: Record<string, string> };
    assert.equal(saved.aliases[alias], "starcoder2:3b");

    await command.handler("alias list starcoder2:3b", ctx);
    assert.match(lastNotification(ctx).message, new RegExp(`Aliases for starcoder2:3b:[\\s\\S]*${alias}`));

    await command.handler(`model ${alias} qwen-fim`, ctx);
    const entry = appendedEntries.at(-1)?.data as { model?: string; promptMode?: string };
    assert.equal(entry.model, "starcoder2:3b");
    assert.equal(entry.promptMode, "qwen-fim");

    await command.handler(`alias delete starcoder2:3b ${alias}`, ctx);
    assert.match(lastNotification(ctx).message, new RegExp(`Alias deleted: ${alias} for model starcoder2:3b`));
  } finally {
    cleanupTempAgentDir(dir);
  }
});

test("/ac debug toggles the debug widget and validates arguments", async () => {
  const dir = useTempAgentDir();
  try {
    const { pi, commands } = createMockPi();
    ghostVim(pi as never);

    const command = getAcCommand(commands);
    const ctx = createMockContext();

    await command.handler("debug on", ctx);
    assert.match(lastNotification(ctx).message, /pi-ghost-vim debug enabled/);
    assert.match(lastNotification(ctx).message, /trace file:/);
    assert.deepEqual(ctx.ui.widgets.at(-1)?.key, "pi-ghost-vim-debug");
    assert.ok(ctx.ui.widgets.at(-1)?.value?.some((line) => line.includes("model=qwen2.5-coder:1.5b")));
    assert.ok(ctx.ui.widgets.at(-1)?.value?.some((line) => line.includes("trace=")));

    const findTraceFileEventually = async (targetDir: string): Promise<string> => {
      for (let attempt = 0; attempt < 25; attempt++) {
        const matching = readdirSync(targetDir).filter((f) =>
          f.startsWith("pi-ghost-vim-debug-") && f.endsWith(".md")
        );
        if (matching.length > 0) {
          return path.join(targetDir, matching[0]);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("expected stamped trace file to be created");
    };

    const traceFile = await findTraceFileEventually(dir);
    const trace = await readFileEventually(traceFile, '"event":"debug-enabled"');

    assert.ok(trace.includes("model: qwen2.5-coder:1.5b"));

    const traceLines = trace.trim().split("\n").filter((line) => line.includes("{"));
    assert.ok(traceLines.length > 0);
    assert.ok(traceLines[0].includes("debug: enabled"));

    await command.handler("debug maybe", ctx);
    assert.equal(lastNotification(ctx).level, "warning");
    assert.match(lastNotification(ctx).message, /Invalid argument for debug/);

    await command.handler("debug off", ctx);
    assert.equal(lastNotification(ctx).message, "pi-ghost-vim debug disabled");
    assert.equal(ctx.ui.widgets.at(-1)?.key, "pi-ghost-vim-debug");
    assert.equal(ctx.ui.widgets.at(-1)?.value, undefined);
  } finally {
    cleanupTempAgentDir(dir);
  }
});

test("/ac getArgumentCompletions returns expected suggestions", async () => {
  const dir = useTempAgentDir();
  try {
    const { pi, commands } = createMockPi();
    ghostVim(pi as never);

    const command = getAcCommand(commands);
    assert.ok(command.getArgumentCompletions, "expected getArgumentCompletions to be defined");

    // 1. Root /ac suggestions
    const rootCompletions = command.getArgumentCompletions("");
    assert.ok(rootCompletions);
    const rootValues = rootCompletions.map((c) => c.value);
    assert.deepEqual(rootValues, ["model", "status", "debug", "alias", "help"]);

    // 2. Partial subcommand
    const partialSub = command.getArgumentCompletions("mo");
    assert.ok(partialSub);
    assert.deepEqual(partialSub.map((c) => c.value), ["model"]);

    // 3. /ac model suggestions
    const modelCompletions = command.getArgumentCompletions("model ");
    assert.ok(modelCompletions);
    const modelValues = modelCompletions.map((c) => c.value);
    assert.ok(modelValues.includes("model list"));
    assert.ok(modelValues.includes("model qwen2.5-coder:1.5b"));
    assert.ok(modelValues.includes("model qwen"));
    assert.ok(modelValues.includes("model gemma"));

    // 4. /ac model with partial
    const modelPartial = command.getArgumentCompletions("model qw");
    assert.ok(modelPartial);
    assert.deepEqual(modelPartial.map((c) => c.value), ["model qwen2.5-coder:1.5b", "model qwen"]);

    // 5. /ac model mode suggestions
    const modeCompletions = command.getArgumentCompletions("model qwen ");
    assert.ok(modeCompletions);
    assert.deepEqual(modeCompletions.map((c) => c.value), ["model qwen auto", "model qwen qwen-fim", "model qwen instruct"]);

    // 6. /ac debug suggestions
    const debugCompletions = command.getArgumentCompletions("debug o");
    assert.ok(debugCompletions);
    assert.deepEqual(debugCompletions.map((c) => c.value), ["debug on", "debug off"]);

    // 7. /ac alias suggestions
    const aliasCompletions = command.getArgumentCompletions("alias ");
    assert.ok(aliasCompletions);
    assert.deepEqual(aliasCompletions.map((c) => c.value), ["alias add", "alias list", "alias delete", "alias reset"]);

    // 8. Custom alias deletion autocomplete
    const ctx = createMockContext();
    await command.handler("alias add starcoder2:3b my-star", ctx);

    const deleteModelCompletions = command.getArgumentCompletions("alias delete ");
    assert.ok(deleteModelCompletions);
    assert.deepEqual(deleteModelCompletions.map((c) => c.value), ["alias delete starcoder2:3b"]);

    const deleteAliasCompletions = command.getArgumentCompletions("alias delete starcoder2:3b ");
    assert.ok(deleteAliasCompletions);
    assert.deepEqual(deleteAliasCompletions.map((c) => c.value), ["alias delete starcoder2:3b my-star"]);

  } finally {
    cleanupTempAgentDir(dir);
  }
});

test("/ac model default updates default model and last used model persists", async () => {
  const dir = useTempAgentDir();
  try {
    const { pi, commands, sessionHandlers } = createMockPi();
    ghostVim(pi as never);

    const command = getAcCommand(commands);
    const ctx = createMockContext();

    // 1. Set default model
    await command.handler("model default gemma", ctx);
    assert.match(lastNotification(ctx).message, /default model: gemma4:e4b/);

    // 2. Set active model to qwen
    await command.handler("model qwen instruct", ctx);
    assert.match(lastNotification(ctx).message, /model: qwen2\.5-coder:1\.5b/);

    // 3. Trigger session_start to reload config
    const handlers = sessionHandlers.get("session_start");
    assert.ok(handlers);
    for (const handler of handlers) {
      handler(null, ctx);
    }

    // After session_start, config has been reloaded. Let's check status:
    await command.handler("model", ctx);
    assert.match(lastNotification(ctx).message, /model: qwen2\.5-coder:1\.5b/);
    assert.match(lastNotification(ctx).message, /default model: gemma4:e4b/);
  } finally {
    cleanupTempAgentDir(dir);
  }
});
