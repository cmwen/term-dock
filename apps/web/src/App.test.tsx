import { render, screen } from "@testing-library/react";
import App from "./App";

describe("remote web shell", () => {
  it("requests an in-memory relay connection without exposing a token in a URL", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "Open your Term Dock remotely" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Relay WebSocket endpoint")).toHaveValue("");
    expect(screen.getByLabelText("Short-lived access token")).toHaveAttribute(
      "type",
      "password",
    );
    expect(
      screen.getByText(/never stored in this web app/i),
    ).toBeInTheDocument();
  });
});
