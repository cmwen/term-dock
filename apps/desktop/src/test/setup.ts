import "@testing-library/jest-dom/vitest";

Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    open() {}
    write() {}
    focus() {}
    resize() {}
    onData() {
      return { dispose() {} };
    }
    dispose() {}
  },
}));
