import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type WidgetCapableUi = ExtensionContext["ui"] & {
  setWidget?: (
    key: string,
    value: string[] | undefined,
    options?: { placement?: string },
  ) => void;
  setStatus?: (key: string, value: string | undefined) => void;
};

export function printOllamaStatusOutput(
  ctx: ExtensionContext,
  result: { ok: boolean; lines: string[] },
): void {
  const status = result.ok ? "passed" : "failed";
  ctx.ui.notify([...result.lines, `status: ${status}`].join("\n"), result.ok ? "info" : "warning");
}

export function setGhostWidget(ctx: ExtensionContext, key: string, lines: string[]): void {
  const ui = ctx.ui as WidgetCapableUi;
  if (typeof ui.setWidget === "function") {
    ui.setWidget(key, lines.length > 0 ? lines : undefined, {
      placement: "belowEditor",
    });
    return;
  }

  ui.setStatus?.(key, lines[0]);
}

export function clearGhostWidget(ctx: ExtensionContext, key: string): void {
  const ui = ctx.ui as WidgetCapableUi;
  ui.setWidget?.(key, undefined);
  ui.setStatus?.(key, undefined);
}

export function dimWithTheme(ctx: ExtensionContext, text: string): string {
  return ctx.ui.theme?.fg?.("dim", text) ?? text;
}
