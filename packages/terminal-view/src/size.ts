import type { TerminalSize } from "@term-dock/broker-contract";

const CHARACTER_WIDTH = 8.25;
const ROW_HEIGHT = 18;
const HORIZONTAL_PADDING = 24;
const VERTICAL_PADDING = 24;
const MAX_ROWS = 500;
const MAX_COLUMNS = 1_000;

/** Returns a safe PTY size or undefined until the terminal has a real layout. */
export function terminalSizeForBounds(
  width: number,
  height: number,
): TerminalSize | undefined {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    return undefined;
  return {
    columns: Math.min(
      MAX_COLUMNS,
      Math.max(1, Math.floor((width - HORIZONTAL_PADDING) / CHARACTER_WIDTH)),
    ),
    rows: Math.min(
      MAX_ROWS,
      Math.max(1, Math.floor((height - VERTICAL_PADDING) / ROW_HEIGHT)),
    ),
  };
}
