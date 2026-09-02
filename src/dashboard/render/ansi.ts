export const ANSI = Object.freeze({
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  // CodeBurn-inspired terminal palette: violet carries structure, orange
  // carries focus and activity. 256-color escapes work in Terminal.app,
  // iTerm2, and modern CI TTYs without requiring a background color.
  purple: "\u001b[38;5;141m",
  purpleDeep: "\u001b[38;5;99m",
  purpleBright: "\u001b[38;5;183m",
  purpleDim: "\u001b[38;5;103m",
  orange: "\u001b[38;5;208m",
  orangeBright: "\u001b[38;5;214m",
  cyan: "\u001b[36m",
  blue: "\u001b[34m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  white: "\u001b[37m",
  clearLine: "\u001b[2K",
  cursorHome: "\u001b[H",
  cursorHide: "\u001b[?25l",
  cursorShow: "\u001b[?25h",
});

export interface AnsiOptions {
  readonly isTTY?: boolean;
  readonly ansi?: boolean;
  readonly color?: boolean;
}

export function ansiEnabled(options: AnsiOptions = {}): boolean {
  if (options.isTTY !== true) return false;
  return options.ansi !== false;
}

export function colorEnabled(options: AnsiOptions = {}): boolean {
  if (!ansiEnabled(options) || options.color === false) return false;
  if (typeof process !== "undefined" && process.env.NO_COLOR !== undefined) return false;
  return true;
}

export function paint(value: string, code: string, enabled: boolean): string {
  return enabled ? code + value + ANSI.reset : value;
}

export function emphasis(value: string, enabled: boolean): string {
  return paint(value, ANSI.bold, enabled);
}

export function themePurple(value: string, enabled: boolean, bright = false): string {
  return paint(value, bright ? ANSI.purpleBright : ANSI.purple, enabled);
}

export function themeOrange(value: string, enabled: boolean, bright = false): string {
  return paint(value, bright ? ANSI.orangeBright : ANSI.orange, enabled);
}

export function statusColor(
  value: string,
  state: "complete" | "partial" | "stale",
  enabled: boolean,
): string {
  const code = state === "complete" ? ANSI.green : state === "partial" ? ANSI.yellow : ANSI.red;
  return paint(value, code, enabled);
}

/**
 * Return an in-place frame. It homes the cursor and erases each rendered line,
 * so redraws do not append stale content or require a full terminal clear.
 */
export function renderInPlace(
  content: string,
  previousLineCount = 0,
  options: AnsiOptions = {},
): string {
  if (!ansiEnabled(options)) return content;
  const lines = content.split("\n");
  const lineCountToErase = Math.max(previousLineCount, lines.length);
  const frame = lines.map((line) => ANSI.clearLine + line).join("\n");
  const trailing = Array.from({ length: Math.max(0, lineCountToErase - lines.length) }, () => ANSI.clearLine).join("\n");
  return ANSI.cursorHome + frame + (trailing ? "\n" + trailing : "");
}

export function terminalCleanup(options: AnsiOptions = {}): string {
  return ansiEnabled(options) ? ANSI.cursorShow + ANSI.reset : "";
}
