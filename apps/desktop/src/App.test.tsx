import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";

describe("workspace dashboard", () => {
  it("shows the local-first workspace health and safe AI context", async () => {
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "Term Dock" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Portable context without transcript leakage"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /AI context/i }));
    await waitFor(() =>
      expect(screen.getByLabelText("AI context preview")).toHaveTextContent(
        "term-dock.ai-context/v1",
      ),
    );
  });

  it("creates a workspace in the browser preview", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Term Dock" });
    fireEvent.click(screen.getByRole("button", { name: /New workspace/i }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Notes" },
    });
    fireEvent.change(screen.getByLabelText("Local directory"), {
      target: { value: "/tmp/notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(
      await screen.findByRole("heading", { name: "Notes" }),
    ).toBeInTheDocument();
  });

  it("edits a workspace through the shared broker operation", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Term Dock" }));
    await screen.findByRole("heading", { name: "Term Dock" });
    fireEvent.click(screen.getByRole("button", { name: /Edit workspace/i }));
    fireEvent.change(screen.getByLabelText("SSH target (optional alias)"), {
      target: { value: "dev-box" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
    expect(
      await screen.findByRole("heading", { name: "Term Dock" }),
    ).toBeInTheDocument();
    expect(screen.getByText("dev-box")).toBeInTheDocument();
  });

  it("attaches the reusable terminal client through the broker contract", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Term Dock" });
    fireEvent.click(screen.getByRole("button", { name: "Term Dock" }));
    await screen.findByRole("heading", { name: "Term Dock" });
    fireEvent.click(screen.getByRole("button", { name: /Needs attention/i }));
    expect(
      await screen.findByLabelText("Terminal session"),
    ).toBeInTheDocument();
    expect(await screen.findByText(/controller/i)).toBeInTheDocument();
  });

  it("resumes an existing durable session before launching another one", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Term Dock" }));
    await screen.findByRole("heading", { name: "Term Dock" });
    fireEvent.click(screen.getByRole("button", { name: "Resume session" }));
    expect(
      await screen.findByLabelText("Terminal session"),
    ).toBeInTheDocument();
  });

  it("issues a scoped one-time remote device grant in the preview", async () => {
    render(<App />);
    await screen.findByRole("button", { name: /Remote access/i });
    fireEvent.click(screen.getByRole("button", { name: /Remote access/i }));
    fireEvent.change(await screen.findByLabelText("Device label"), {
      target: { value: "Personal iPad" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Create one-time grant/i }),
    );
    expect(
      await screen.findByText(/Copy this secret now/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Viewer grant for Personal iPad/i),
    ).toBeInTheDocument();
  });

  it("archives a workspace without terminating a session", async () => {
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "API migration" }),
    );
    await screen.findByRole("heading", { name: "API migration" });
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(
      await screen.findByLabelText("Archive workspace"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive workspace" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "API migration" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("requires an explicit confirmation before ending a session", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Term Dock" }));
    await screen.findByRole("heading", { name: "Term Dock" });
    fireEvent.click(screen.getByRole("button", { name: /Needs attention/i }));
    await screen.findByLabelText("Terminal session");
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    expect(screen.getByText("End this terminal process?")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm end session" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Terminal session"),
      ).not.toBeInTheDocument(),
    );
  });
});
