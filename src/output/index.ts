import type { Writable } from "node:stream";
import { renderDashboard } from "../dashboard/render/dashboard.js";
import { renderInPlace, type AnsiOptions } from "../dashboard/render/ansi.js";
import { renderJSON } from "./json.js";
import { renderTable } from "./table.js";
import type { DashboardSnapshotInput, OutputOptions } from "../dashboard/render/types.js";

export * from "./json.js";
export * from "./table.js";
export * from "../dashboard/render/types.js";
export * from "../dashboard/render/format.js";
export * from "../dashboard/render/ansi.js";
export * from "../dashboard/render/dashboard.js";
export * from "../dashboard/render/redraw.js";

export interface WriteOutputOptions extends OutputOptions {
  readonly stream?: Writable;
}

/**
 * Auto mode is a dashboard only for an actual TTY. Redirected output is
 * always plain table text, so pipes never receive cursor or color escapes.
 */
export function renderOutput(
  input: DashboardSnapshotInput,
  options: OutputOptions = {},
): string {
  const format = options.format ?? "auto";
  if (format === "json") return renderJSON(input, options.prettyJson === true);
  if (format === "table") return renderTable(input);
  if (format === "dashboard") return renderDashboard(input, options);
  return options.isTTY === true ? renderDashboard(input, options) : renderTable(input);
}

export function writeOutput(
  input: DashboardSnapshotInput,
  options: WriteOutputOptions = {},
): void {
  const stream = options.stream ?? process.stdout;
  const isTTY = options.isTTY ?? Boolean((stream as Writable & { isTTY?: boolean }).isTTY);
  const rendered = renderOutput(input, { ...options, isTTY });
  stream.write(rendered.endsWith("\n") ? rendered : rendered + "\n");
}

/** Render one TTY frame using cursor-home and line-erasure redraw semantics. */
export function renderRedraw(
  input: DashboardSnapshotInput,
  options: OutputOptions = {},
): string {
  const { previousLineCount, ...dashboardOptions } = options;
  const rendered = renderDashboard(input, {
    ...dashboardOptions,
    isTTY: true,
    ansi: true,
  });
  return renderInPlace(rendered, previousLineCount ?? 0, {
    isTTY: true,
    ansi: true,
    color: options.color,
  } satisfies AnsiOptions);
}
