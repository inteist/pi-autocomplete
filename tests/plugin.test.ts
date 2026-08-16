import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AutocompleteItem } from "@earendil-works/pi-tui";

import autocompleteVim from "../src/index.js";
import { resolveModelAlias } from "../src/aliases.js";
import { AutocompleteVimWrapper } from "../src/editor-wrapper.js";
import { cleanupCompletion, getCompletionRejectionReason } from "../src/completion.js";
import { resolvePromptMode } from "../src/config.js";
import {
  buildGenerateRequest,
  buildLfmPrefillPrompt,
  shouldUseRawGenerate,
  trimLfmPrefillEnd,
} from "../src/ollama.js";
import {
  CompletionTraceTracker,
  TraceRecorder,
  type CompletionTraceDraft,
} from "../src/trace-recorder.js";
import { AC_TRACE_SCHEMA, TRACE_FILE_PREFIX } from "../src/trace-schema.js";
import {
  getDailyTraceFile,
  formatTraceDate,
  summarizeTraceFile,
} from "../src/trace-writer.js";
import type { AutocompleteConfig } from "../src/types.js";

const baseTestConfig: AutocompleteConfig = {
  model: "LFM25:2.6b",
  promptMode: "auto",
  ollamaUrl: "http://127.0.0.1:11434",
  keepAlive: "30m",
  debounceMs: 250,
  timeoutMs: 2500,
  checkTimeoutMs: 10_000,
  doubleTabMs: 350,
  minChars: 8,
  maxTokens: 48,
  inline: true,
  debug: false,
  trace: false,
  traceDir: "",
};

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
  process.env.PI_AC_TRACE_DIR = path.join(dir, "ac-traces");
  process.env.PI_AUTOCOMPLETE_MODEL = "qwen2.5-coder:1.5b";
  return dir;
}

function cleanupTempAgentDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_AC_TRACE_DIR;
  delete process.env.PI_AC_TRACE;
  delete process.env.PI_AUTOCOMPLETE_MODEL;
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
    autocompleteVim(pi as never);

    assert.ok(commands.has("ac"));

    const command = getAcCommand(commands);
    const ctx = createMockContext();

    await command.handler("model", ctx);
    assert.match(lastNotification(ctx).message, /model: qwen2\.5-coder:1\.5b/);
    assert.match(lastNotification(ctx).message, /prompt mode: qwen-fim \(auto\)/);

    await command.handler("model gemma instruct", ctx);
    const gemmaEntry = appendedEntries.at(-1);
    assert.equal(gemmaEntry?.customType, "pi-autocomplete-model");
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
    autocompleteVim(pi as never);

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
    autocompleteVim(pi as never);

    const command = getAcCommand(commands);
    const ctx = createMockContext();

    await command.handler("debug on", ctx);
    assert.match(lastNotification(ctx).message, /pi-autocomplete debug enabled/);
    assert.match(lastNotification(ctx).message, /debug file:/);
    assert.match(lastNotification(ctx).message, /trace file:/);
    assert.deepEqual(ctx.ui.widgets.at(-1)?.key, "pi-autocomplete-debug");
    assert.ok(ctx.ui.widgets.at(-1)?.value?.some((line) => line.includes("model=qwen2.5-coder:1.5b")));
    assert.ok(ctx.ui.widgets.at(-1)?.value?.some((line) => line.includes("debug=")));

    // The verbose stream is a daily JSONL file inside the central trace directory,
    // not a per-session file next to whichever project Pi happened to run in.
    const debugFile = path.join(
      dir,
      "ac-traces",
      "debug",
      `ac-debug-${formatTraceDate(new Date())}.jsonl`,
    );
    const trace = await readFileEventually(debugFile, '"event":"debug-enabled"');

    const records = trace
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records[0].event, "debug-open");
    assert.equal(records[0].model, "qwen2.5-coder:1.5b");
    assert.ok(records.every((record) => typeof record.ts === "string"));
    assert.ok(records.some((record) => record.msg === "debug: enabled"));

    await command.handler("debug maybe", ctx);
    assert.equal(lastNotification(ctx).level, "warning");
    assert.match(lastNotification(ctx).message, /Invalid argument for debug/);

    await command.handler("debug off", ctx);
    assert.equal(lastNotification(ctx).message, "pi-autocomplete debug disabled");
    assert.equal(ctx.ui.widgets.at(-1)?.key, "pi-autocomplete-debug");
    assert.equal(ctx.ui.widgets.at(-1)?.value, undefined);
  } finally {
    cleanupTempAgentDir(dir);
  }
});

test("/ac trace reports the central location and toggles recording", async () => {
  const dir = useTempAgentDir();
  try {
    const { pi, commands } = createMockPi();
    autocompleteVim(pi as never);

    const command = getAcCommand(commands);
    const ctx = createMockContext();
    const traceDir = path.join(dir, "ac-traces");

    await command.handler("trace", ctx);
    const status = lastNotification(ctx).message;
    assert.match(status, /recording: on/);
    assert.ok(status.includes(`directory: ${traceDir}`));
    assert.ok(status.includes(path.join(traceDir, `ac-trace-${formatTraceDate(new Date())}.jsonl`)));
    assert.match(status, /records today: none yet/);

    await command.handler("trace off", ctx);
    assert.match(lastNotification(ctx).message, /trace recording disabled/);
    const persisted = JSON.parse(
      readFileSync(path.join(dir, "autocomplete-config.json"), "utf8"),
    ) as { traceEnabled?: boolean };
    assert.equal(persisted.traceEnabled, false);

    await command.handler("trace on", ctx);
    assert.match(lastNotification(ctx).message, /recording: on/);

    await command.handler("trace maybe", ctx);
    assert.equal(lastNotification(ctx).level, "warning");
    assert.match(lastNotification(ctx).message, /Invalid argument for trace/);
  } finally {
    cleanupTempAgentDir(dir);
  }
});

test("/ac getArgumentCompletions returns expected suggestions", async () => {
  const dir = useTempAgentDir();
  try {
    const { pi, commands } = createMockPi();
    autocompleteVim(pi as never);

    const command = getAcCommand(commands);
    assert.ok(command.getArgumentCompletions, "expected getArgumentCompletions to be defined");

    // 1. Root /ac suggestions
    const rootCompletions = command.getArgumentCompletions("");
    assert.ok(rootCompletions);
    const rootValues = rootCompletions.map((c) => c.value);
    assert.deepEqual(rootValues, ["model", "status", "trace", "debug", "alias", "help"]);

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
    assert.ok(modelValues.includes("model LFM25:2.6b"));
    assert.ok(modelValues.includes("model lfm"));

    // 4. /ac model with partial
    const modelPartial = command.getArgumentCompletions("model qw");
    assert.ok(modelPartial);
    assert.deepEqual(modelPartial.map((c) => c.value), ["model qwen2.5-coder:1.5b", "model qwen"]);

    // 5. /ac model mode suggestions
    const modeCompletions = command.getArgumentCompletions("model qwen ");
    assert.ok(modeCompletions);
    assert.deepEqual(modeCompletions.map((c) => c.value), [
      "model qwen auto",
      "model qwen qwen-fim",
      "model qwen instruct",
      "model qwen lfm-prefill",
    ]);

    // 6. /ac debug suggestions
    const debugCompletions = command.getArgumentCompletions("debug o");
    assert.ok(debugCompletions);
    assert.deepEqual(debugCompletions.map((c) => c.value), ["debug on", "debug off"]);

    // 6b. /ac trace suggestions
    const traceCompletions = command.getArgumentCompletions("trace ");
    assert.ok(traceCompletions);
    assert.deepEqual(traceCompletions.map((c) => c.value), [
      "trace status",
      "trace on",
      "trace off",
    ]);

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
    autocompleteVim(pi as never);

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

type TraceEnv = {
  dir: string;
  config: AutocompleteConfig;
  tracker: CompletionTraceTracker;
};

function createTraceEnv(overrides: Partial<AutocompleteConfig> = {}): TraceEnv {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ac-traces-"));
  const config: AutocompleteConfig = { ...baseTestConfig, trace: true, traceDir: dir, ...overrides };
  return { dir, config, tracker: new CompletionTraceTracker(new TraceRecorder(config)) };
}

function createDraft(
  config: AutocompleteConfig,
  prefix: string,
  raw: string,
  overrides: Partial<CompletionTraceDraft> = {},
): CompletionTraceDraft {
  const now = Date.now();
  return {
    requestId: 1,
    hint: "shown",
    reason: null,
    prefix,
    suffix: "",
    context: { line: 0, col: prefix.length, lines: 1, trigger: "h" },
    model: config.model,
    promptMode: config.promptMode,
    resolvedPromptMode: resolvePromptMode(config),
    request: buildGenerateRequest(prefix, "", config, config.maxTokens),
    raw,
    completion: raw,
    rejectReason: null,
    metrics: {
      done_reason: "stop",
      totalMs: 230,
      loadMs: 0,
      promptEvalMs: 120,
      prompt_eval_count: 210,
      evalMs: 100,
      eval_count: 8,
    },
    scheduledAt: now - 400,
    startedAt: now - 250,
    finishedAt: now,
    requestMs: 230,
    debounceMs: config.debounceMs,
    error: null,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readTraceRecords(dir: string): any[] {
  const file = getDailyTraceFile(dir, TRACE_FILE_PREFIX);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("a rejected suggestion is traced next to the text the user typed instead", () => {
  const { dir, config, tracker } = createTraceEnv({ model: "LFM25:2.6b" });
  try {
    const prefix = "make the debounce configurable so slow mach";
    const suggestion = "ines do not fire on every keystroke";

    tracker.recordShown(createDraft(config, prefix, suggestion), suggestion);
    tracker.noteDismiss("typing");
    tracker.noteText(`${prefix}ines can`);
    tracker.noteSubmit(`${prefix}ines can keep up with the model`);

    const records = readTraceRecords(dir);
    assert.equal(records.length, 2);

    const [completion, submission] = records;
    assert.equal(completion.schema, AC_TRACE_SCHEMA);
    assert.equal(completion.type, "completion");
    assert.equal(completion.model.id, "ollama/LFM25:2.6b");
    assert.equal(completion.model.prompt_mode, "lfm-prefill");
    assert.equal(completion.model.prompt_mode_setting, "auto");
    assert.equal(completion.model.raw, true);
    assert.equal(completion.context.prefix, prefix);
    assert.equal(completion.context.word_prefix, "mach");
    assert.equal(completion.context.at_word_boundary, false);
    assert.equal(completion.response.raw, suggestion);
    assert.equal(completion.response.done_reason, "stop");
    assert.equal(completion.timing.ollama.prompt_tokens, 210);
    assert.equal(completion.timing.ollama.tokens_per_second, 80);
    assert.ok(completion.prompt.text.endsWith(prefix));
    assert.match(completion.prompt.hash, /^sha256:[0-9a-f]{12}$/);

    // The point of the record: suggestion vs. reality, on the same prefix.
    assert.equal(completion.outcome.status, "shown_rejected");
    assert.equal(completion.outcome.shown, true);
    assert.equal(completion.outcome.reason, "typing");
    assert.equal(completion.outcome.typed_text, "ines can keep up with the model");
    assert.equal(completion.outcome.typed_source, "submit");
    assert.equal(completion.outcome.accepted_chars, 0);
    assert.equal(completion.outcome.match.common_prefix_chars, 5);
    assert.equal(completion.outcome.match.typed_starts_with_suggestion, false);

    assert.equal(submission.type, "submission");
    assert.equal(submission.text, `${prefix}ines can keep up with the model`);
    assert.deepEqual(submission.stats, {
      requests: 1,
      shown: 1,
      accepted: 0,
      filtered: 0,
      stale: 0,
      errors: 0,
      accepted_chars: 0,
      accepted_ratio: 0,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accepting a suggestion chunk by chunk traces it as fully accepted", () => {
  const { dir, config, tracker } = createTraceEnv();
  try {
    const prefix = "add a status command that ch";
    const suggestion = "ecks the connection";

    tracker.recordShown(createDraft(config, prefix, suggestion), suggestion);
    tracker.noteText(`${prefix}ecks`);
    tracker.noteAccept("ecks", " the connection");
    tracker.noteText(`${prefix}${suggestion}`);
    tracker.noteAccept(" the connection", "");

    const [record] = readTraceRecords(dir);
    assert.equal(record.outcome.status, "accepted_full");
    assert.equal(record.outcome.accepted_chars, suggestion.length);
    assert.equal(record.outcome.accepted_text, suggestion);
    assert.equal(record.outcome.accept_events, 2);
    assert.equal(record.outcome.typed_source, "accept");
    assert.equal(record.outcome.match.typed_starts_with_suggestion, true);
    assert.equal(record.outcome.match.common_prefix_ratio, 1);
    assert.ok(record.outcome.decision_ms !== null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a partially accepted suggestion keeps both the accepted and the typed text", () => {
  const { dir, config, tracker } = createTraceEnv();
  try {
    const prefix = "add a status command that ch";
    const suggestion = "ecks the connection";

    tracker.recordShown(createDraft(config, prefix, suggestion), suggestion);
    tracker.noteText(`${prefix}ecks`);
    tracker.noteAccept("ecks", " the connection");
    tracker.noteDismiss("typing");
    tracker.noteSubmit(`${prefix}ecks ollama is reachable`);

    const [record, submission] = readTraceRecords(dir);
    assert.equal(record.outcome.status, "accepted_partial");
    assert.equal(record.outcome.accepted_text, "ecks");
    assert.equal(record.outcome.accepted_chars, 4);
    assert.equal(record.outcome.typed_text, "ecks ollama is reachable");
    assert.equal(record.outcome.match.common_prefix_chars, 5);
    assert.equal(submission.stats.accepted, 1);
    assert.equal(submission.stats.accepted_chars, 4);
    assert.ok(submission.stats.accepted_ratio > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("suggestions that never reach the screen are traced with their reason", () => {
  const { dir, config, tracker } = createTraceEnv();
  try {
    const prefix = "the tests fail because the mock";

    tracker.recordUnshown(
      createDraft(config, prefix, "I'm sorry, I need more context.", {
        requestId: 7,
        hint: "filtered",
        reason: "chat-like",
        rejectReason: "chat-like",
        completion: "I'm sorry, I need more context.",
      }),
    );
    tracker.recordUnshown(
      createDraft(config, prefix, "", {
        requestId: 8,
        hint: "error",
        reason: "timeout",
        raw: null,
        completion: null,
        metrics: null,
        error: { message: "Error: timeout", timedOut: true, aborted: true },
      }),
    );

    // The failed request settles immediately; the filtered one waits for the outcome.
    const afterError = readTraceRecords(dir);
    assert.equal(afterError.length, 1);
    assert.equal(afterError[0].outcome.status, "error");
    assert.equal(afterError[0].response, null);
    assert.equal(afterError[0].error.timed_out, true);
    assert.equal(afterError[0].request_id, 8);

    tracker.noteSubmit(`${prefix} returns undefined`);

    const records = readTraceRecords(dir);
    const filtered = records.find((record) => record.request_id === 7);
    assert.equal(filtered.outcome.status, "filtered");
    assert.equal(filtered.outcome.shown, false);
    assert.equal(filtered.outcome.reason, "chat-like");
    assert.equal(filtered.response.reject_reason, "chat-like");
    assert.equal(filtered.response.raw, "I'm sorry, I need more context.");
    assert.equal(filtered.outcome.typed_text, " returns undefined");

    const submission = records.at(-1);
    assert.equal(submission.stats.filtered, 1);
    assert.equal(submission.stats.errors, 1);
    assert.equal(submission.stats.shown, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trace recording writes one daily file and can be switched off", () => {
  const { dir, config, tracker } = createTraceEnv();
  try {
    const prefix = "run the check before the release";
    tracker.recordShown(createDraft(config, prefix, " is cut"), " is cut");
    tracker.noteSubmit(`${prefix} is tagged`);

    const file = getDailyTraceFile(dir, TRACE_FILE_PREFIX);
    assert.equal(path.basename(file), `ac-trace-${formatTraceDate(new Date())}.jsonl`);

    const summary = summarizeTraceFile(file);
    assert.equal(summary.exists, true);
    assert.equal(summary.completions, 1);
    assert.equal(summary.shown, 1);
    assert.equal(summary.submissions, 1);
    assert.ok(summary.bytes > 0);

    config.trace = false;
    tracker.recordShown(createDraft(config, prefix, " is cut"), " is cut");
    tracker.noteSubmit(`${prefix} is tagged`);
    assert.equal(summarizeTraceFile(file).records, summary.records);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Minimal stand-in for the editor pi-vim would hand us. */
class MockBaseEditor {
  text = "";
  onSubmit: ((text: string) => void) | undefined;
  actionHandlers = new Map<string, () => void>();

  getText(): string {
    return this.text;
  }
  setText(text: string): void {
    this.text = text;
  }
  handleInput(data: string): void {
    if (data === "\t" || data === "\x1b") return;
    this.text += data;
  }
  getCursor(): { line: number; col: number } {
    const lines = this.text.split("\n");
    return { line: lines.length - 1, col: (lines.at(-1) ?? "").length };
  }
  getLines(): string[] {
    return this.text.split("\n");
  }
  isShowingAutocomplete(): boolean {
    return false;
  }
  render(): string[] {
    return [this.text];
  }
  invalidate(): void {}
  dispose(): void {}
}

function stubOllama(response: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        response,
        done: true,
        done_reason: "stop",
        total_duration: 200_000_000,
        load_duration: 0,
        prompt_eval_count: 120,
        prompt_eval_duration: 100_000_000,
        eval_count: 6,
        eval_duration: 60_000_000,
      }),
      { headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

test("typing, showing and accepting autocomplete text produces a trace end to end", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ac-traces-"));
  const restoreFetch = stubOllama(" keeps the model idle");
  try {
    const config: AutocompleteConfig = {
      ...baseTestConfig,
      model: "gemma4:e4b",
      promptMode: "instruct",
      debounceMs: 5,
      trace: true,
      traceDir: dir,
    };
    const baseEditor = new MockBaseEditor();
    const wrapper = new AutocompleteVimWrapper({
      ctx: {
        ui: {
          theme: { fg: (_style: string, text: string) => text },
          setWidget: () => {},
          setStatus: () => {},
        },
      },
      tui: { requestRender: () => {} },
      keybindings: {},
      baseEditor,
      getExternalMode: () => "insert",
      config,
      recorder: new TraceRecorder(config),
      debug: () => {},
      isDebugEnabled: () => false,
    } as never);

    const typed = "improve the debounce so";
    for (const char of typed) wrapper.handleInput(char);
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Tab accepts the first chunk of the visible autocomplete.
    wrapper.handleInput("\t");
    assert.equal(baseEditor.getText(), `${typed} keeps`);

    wrapper.onSubmit = () => {};
    wrapper.onSubmit?.(`${typed} keeps the model idle`);

    const records = readTraceRecords(dir);
    const completion = records.find((record) => record.type === "completion");
    assert.ok(completion, "expected a completion trace to be written");
    assert.equal(completion.context.prefix, typed);
    assert.equal(completion.context.trigger, "o");
    assert.equal(completion.context.col, typed.length);
    assert.equal(completion.model.id, "ollama/gemma4:e4b");
    assert.equal(completion.model.prompt_mode, "instruct");
    assert.ok(completion.prompt.text.includes(`${typed}<cursor>`));
    assert.equal(completion.response.raw, " keeps the model idle");
    assert.equal(completion.response.completion, " keeps the model idle");
    assert.equal(typeof completion.timing.request_ms, "number");
    assert.equal(completion.timing.ollama.eval_tokens, 6);
    assert.equal(completion.outcome.status, "accepted_partial");
    assert.equal(completion.outcome.accepted_text, " keeps");
    assert.equal(completion.outcome.typed_text, " keeps the model idle");
    assert.equal(completion.outcome.match.typed_starts_with_suggestion, true);

    const submission = records.find((record) => record.type === "submission");
    assert.ok(submission, "expected a submission trace to be written");
    assert.equal(submission.stats.requests, 1);
    assert.equal(submission.stats.accepted, 1);
    assert.equal(submission.stats.accepted_chars, 6);
  } finally {
    restoreFetch();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LFM2.5 models resolve to the prefill prompt mode and raw generation", () => {
  const base: AutocompleteConfig = { ...baseTestConfig, promptMode: "auto" };

  for (const model of ["LFM25:2.6b", "lfm2.5:2.6b", "hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q8_0"]) {
    assert.equal(resolvePromptMode({ ...base, model }), "lfm-prefill", model);
    assert.equal(shouldUseRawGenerate("lfm-prefill", model), true, model);
  }

  // Other models keep their existing resolution.
  assert.equal(resolvePromptMode({ ...base, model: "qwen2.5-coder:1.5b" }), "qwen-fim");
  assert.equal(resolvePromptMode({ ...base, model: "gemma4:e4b" }), "instruct");

  // An explicit mode still wins over the model name.
  assert.equal(
    resolvePromptMode({ ...base, model: "LFM25:2.6b", promptMode: "instruct" }),
    "instruct",
  );

  assert.equal(resolveModelAlias("lfm"), "LFM25:2.6b");
});

test("LFM prefill prompt closes the think block and ends on the unfinished text", () => {
  const prompt = buildLfmPrefillPrompt("add a command that lists all supported mod");

  // A pre-closed think block is what keeps the reasoning model from reasoning: the
  // chat template would otherwise open the assistant turn with a bare `<think>`.
  assert.ok(prompt.startsWith("<|startoftext|><|im_start|>system\n"));
  assert.ok(prompt.includes("<|im_start|>assistant\n<think></think>"));
  assert.ok(!prompt.includes("<think>\n"));

  // The prompt must end inside an open assistant turn, right after the typed text.
  assert.ok(prompt.endsWith("add a command that lists all supported mod"));
  assert.equal(prompt.trimEnd().endsWith("<|im_end|>"), false);

  // Few-shot turns are present and closed.
  assert.equal(prompt.split("<think></think>").length - 1, 4);

  const request = buildGenerateRequest(
    "add a command that lists all supported mod",
    "",
    { ...baseTestConfig, model: "LFM25:2.6b", promptMode: "auto" },
    48,
  );
  assert.equal(request.raw, true);
  assert.equal(request.prompt, prompt);
  assert.ok(request.options.stop.includes("<|im_end|>"));
  assert.ok(request.options.stop.includes("<think>"));
});

test("LFM prefill trims trailing spaces so the model does not see a dangling space", () => {
  // A bare trailing space tokenises on its own and reliably degenerates the output.
  assert.equal(trimLfmPrefillEnd("the retry logic is "), "the retry logic is");
  assert.equal(trimLfmPrefillEnd("the retry logic is\t "), "the retry logic is");
  assert.equal(trimLfmPrefillEnd("finish the word"), "finish the word");
  // Newlines carry layout meaning and are common tokens, so they are kept.
  assert.equal(trimLfmPrefillEnd("first line\n"), "first line\n");

  const prompt = buildLfmPrefillPrompt("the retry logic is ");
  assert.ok(prompt.endsWith("the retry logic is"));

  // The suffix, when present, is described in the user turn rather than prefilled.
  const withSuffix = buildLfmPrefillPrompt("add a ", " command that prints the model");
  assert.ok(withSuffix.includes("Text that follows the cursor:\n command that prints the model"));
  assert.ok(withSuffix.endsWith("add a"));
});

test("cleanup re-aligns whitespace and drops reasoning output", () => {
  // The buffer already holds the space, so the model's own leading space is dropped.
  assert.equal(
    cleanupCompletion({ before: "the retry logic is ", raw: " async and non-blocking" }),
    "async and non-blocking",
  );
  // Mid-word continuations are untouched.
  assert.equal(
    cleanupCompletion({ before: "covering deb", raw: "ounce and caching" }),
    "ounce and caching",
  );
  // Without a trailing space in the buffer, a leading space is meaningful and kept.
  assert.equal(
    cleanupCompletion({ before: "press esc", raw: " twice to dismiss" }),
    " twice to dismiss",
  );

  // Only the answer survives a leaked think block.
  assert.equal(
    cleanupCompletion({
      before: "the tests fail because ",
      raw: "<think>The user wants me to continue.</think>the mock returns undefined",
    }),
    "the mock returns undefined",
  );
  assert.equal(
    cleanupCompletion({ before: "add a ", raw: "<|startoftext|>status command" }),
    "status command",
  );

  // Reasoning narration is rejected rather than shown.
  assert.equal(
    getCompletionRejectionReason("The user wants me to continue the sentence."),
    "chat-like",
  );
  assert.equal(getCompletionRejectionReason("the user can cancel the request"), null);
});
