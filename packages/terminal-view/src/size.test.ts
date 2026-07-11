import { describe, expect, it } from "vitest";
import { terminalSizeForBounds } from "./size";

describe("terminal size calculation", () => {
  it("waits for a real layout and derives safe controller dimensions", () => {
    expect(terminalSizeForBounds(0, 400)).toBeUndefined();
    expect(terminalSizeForBounds(960, 600)).toEqual({
      columns: 113,
      rows: 32,
    });
  });

  it("clamps dimensions to the broker protocol limits", () => {
    expect(terminalSizeForBounds(100_000, 100_000)).toEqual({
      columns: 1_000,
      rows: 500,
    });
  });
});
