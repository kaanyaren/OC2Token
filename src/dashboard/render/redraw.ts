import { renderInPlace, terminalCleanup, type AnsiOptions } from "./ansi.js";

export interface StableRedrawOptions extends AnsiOptions {
  readonly previousLineCount?: number;
}

/** Stateful writer-independent redraw helper for an event-loop-owned terminal. */
export class StableRedraw {
  private previousLineCount = 0;

  render(content: string, options: StableRedrawOptions = {}): string {
    const frame = renderInPlace(content, options.previousLineCount ?? this.previousLineCount, options);
    this.previousLineCount = content.split("\n").length;
    return frame;
  }

  reset(): void {
    this.previousLineCount = 0;
  }

  cleanup(options: StableRedrawOptions = {}): string {
    this.reset();
    return terminalCleanup(options);
  }

  get lineCount(): number {
    return this.previousLineCount;
  }
}

export function createStableRedraw(): StableRedraw {
  return new StableRedraw();
}
