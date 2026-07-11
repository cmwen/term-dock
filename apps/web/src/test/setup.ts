import "@testing-library/jest-dom/vitest";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    open() {}
    write() {}
    onData() {
      return { dispose() {} };
    }
    dispose() {}
  },
}));
