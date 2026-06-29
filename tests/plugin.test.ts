import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import ghostVim from "../src/index.js";

type RegisteredCommand = {
  description?: string;
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
    assert.equal(lastNotification(ctx).message, "pi-ghost-vim debug enabled");
    assert.deepEqual(ctx.ui.widgets.at(-1)?.key, "pi-ghost-vim-debug");
    assert.ok(ctx.ui.widgets.at(-1)?.value?.some((line) => line.includes("model=qwen2.5-coder:1.5b")));

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
