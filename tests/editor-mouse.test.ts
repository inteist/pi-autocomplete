import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type {
  EditorComponent,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { GhostVimWrapper } from "../src/editor-wrapper.js";
import { OllamaPredictor } from "../src/prediction-controller.js";
import type { GhostConfig, GhostWrapperOptions } from "../src/types.js";

const config: GhostConfig = {
  model: "test-model",
  promptMode: "instruct",
  ollamaUrl: "http://127.0.0.1:11434",
  keepAlive: "30m",
  debounceMs: 250,
  timeoutMs: 2500,
  checkTimeoutMs: 10000,
  doubleTabMs: 350,
  minChars: 1,
  maxTokens: 48,
  inline: true,
  debug: false,
  debugTraceFile: "",
};

function mouse(overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return {
    type: "click", button: "left",
    x: 2, y: 1, screenX: 2, screenY: 20,
    width: 80, height: 3,
    shift: false, alt: false, ctrl: false,
    ...overrides,
  };
}

function fixture(mode = "insert") {
  let renders = 0;
  const previews: Array<string[] | undefined> = [];
  const tui = {
    terminal: { rows: 40, columns: 80 },
    requestRender() { renders++; },
  } as unknown as GhostWrapperOptions["tui"];
  const theme = {
    borderColor: (s: string) => s,
    fg: (_style: string, s: string) => s,
  } as unknown as ConstructorParameters<typeof CustomEditor>[1];
  const keybindings = { matches: () => false } as unknown as GhostWrapperOptions["keybindings"];
  const base = new CustomEditor(tui, theme, keybindings);
  const wrapper = new GhostVimWrapper({
    baseEditor: base,
    ctx: {
      ui: {
        theme,
        setWidget(_key: string, value: string[] | undefined) { previews.push(value); },
        setStatus() {},
      },
    } as unknown as GhostWrapperOptions["ctx"],
    tui, keybindings, config: { ...config },
    getExternalMode: () => mode,
    debug() {},
    isDebugEnabled: () => false,
  });
  wrapper.focused = true;
  // Exercise the public optional component hook, including its absence before
  // the fix, rather than accessing wrapper internals.
  const component: EditorComponent = wrapper;
  return { base, wrapper, component, previews, get renders() { return renders; } };
}

for (const mode of ["insert", "normal"]) {
  test(`mouse clicks reach the underlying editor in ${mode} mode`, (t) => {
    const { base, wrapper, component } = fixture(mode);
    t.after(() => wrapper.dispose());
    wrapper.setText("hello world");
    wrapper.render(80);
    assert.deepEqual(base.getCursor(), { line: 0, col: 11 });

    assert.deepEqual(component.handleMouse?.(mouse()), { handled: true, focus: true });
    assert.deepEqual(base.getCursor(), { line: 0, col: 2 });
    assert.equal(wrapper.getText(), "hello world");
  });
}

test("click coordinates are unchanged for padding, wide characters and wrapped lines", (t) => {
  const { base, wrapper, component } = fixture();
  t.after(() => wrapper.dispose());
  base.setPaddingX(1);
  wrapper.setText("a🙂bcdefghijklmnop\nsecond line");
  const lines = wrapper.render(10);

  const emojiClick = mouse({ x: 3, y: 1, width: 10, height: lines.length });
  component.handleMouse?.(emojiClick);
  assert.deepEqual(base.getCursor(), { line: 0, col: 1 });

  const wrappedClick = mouse({ x: 3, y: 2, width: 10, height: lines.length });
  base.handleMouse(wrappedClick);
  const expected = base.getCursor();
  assert.ok(expected.col > 1);
  base.handleMouse(emojiClick);
  component.handleMouse?.(wrappedClick);
  assert.deepEqual(base.getCursor(), expected);
});

test("all mouse events preserve the base receiver, coordinates and result flags", (t) => {
  const { base, wrapper, component } = fixture();
  t.after(() => wrapper.dispose());
  const results: Array<TuiMouseEventResult | undefined> = [
    undefined, { handled: true }, { focus: true }, { capture: true, render: false },
  ];
  for (const type of ["click", "press", "drag", "release", "move", "wheel"] as const) {
    const event = mouse({ type, shift: true, wheelDelta: type === "wheel" ? -3 : undefined });
    for (const result of results) {
      let calls = 0;
      base.handleMouse = function(received) {
        assert.equal(this, base);
        assert.equal(received, event);
        calls++;
        return result;
      };
      assert.equal(component.handleMouse?.(event), result);
      assert.equal(calls, 1);
    }
  }
});

test("unhandled drags and wheels remain available for selection and scrolling", (t) => {
  const { base, wrapper, component } = fixture();
  t.after(() => wrapper.dispose());
  wrapper.setText("hello world");
  wrapper.render(80);
  for (const type of ["press", "drag", "release", "wheel"] as const) {
    assert.equal(component.handleMouse?.(mouse({ type })), undefined);
  }
  assert.deepEqual(base.getCursor(), { line: 0, col: 11 });

  // EditorComponent permits a base editor with no mouse implementation.
  Object.defineProperty(base, "handleMouse", { value: undefined });
  assert.equal(component.handleMouse?.(mouse()), undefined);
});

test("a click dismisses visible ghost text before it can be accepted", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(OllamaPredictor.prototype, "predict", async () => " suggested tail");
  const { wrapper, component, previews } = fixture();
  t.after(() => wrapper.dispose());
  wrapper.handleInput("hello");
  t.mock.timers.tick(250);
  await setImmediate();
  assert.match(previews.at(-1)?.[0] ?? "", /suggested tail/);
  assert.ok(wrapper.render(80).some(line => line.includes("suggested tail")));

  component.handleMouse?.(mouse({ x: 1 }));
  assert.equal(previews.at(-1), undefined);
  assert.ok(wrapper.render(80).every(line => !line.includes("suggested tail")));
  wrapper.handleInput("\t");
  assert.equal(wrapper.getText(), "hello");
});

test("a click cancels queued predictions", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const predict = t.mock.method(OllamaPredictor.prototype, "predict", async () => " tail");
  const { wrapper, component } = fixture();
  t.after(() => wrapper.dispose());
  wrapper.handleInput("hello");
  wrapper.render(80);
  component.handleMouse?.(mouse({ x: 5 }));
  t.mock.timers.tick(250);
  await setImmediate();
  assert.equal(predict.mock.callCount(), 0);
});

test("a click aborts in-flight predictions and drops late responses even at end of text", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  let resolve: (value: string) => void = () => assert.fail("prediction not started");
  t.mock.method(OllamaPredictor.prototype, "predict", (_before: string, _after: string, requestSignal: AbortSignal) => {
    signal = requestSignal;
    return new Promise<string>(done => { resolve = done; });
  });
  const { wrapper, component, previews } = fixture();
  t.after(() => wrapper.dispose());
  wrapper.handleInput("hello");
  wrapper.render(80);
  t.mock.timers.tick(250);
  assert.ok(signal);
  assert.equal(signal.aborted, false);

  component.handleMouse?.(mouse({ x: 5 }));
  assert.equal(signal.aborted, true);
  resolve(" stale tail");
  await setImmediate();
  assert.ok(previews.every(value => value === undefined));
});
