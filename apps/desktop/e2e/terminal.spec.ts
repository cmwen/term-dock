import { expect, test } from "@playwright/test";

test("launches, renders, and accepts terminal input through the broker", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Term Dock" })).toBeVisible();

  await page.getByRole("button", { name: "API migration" }).click();
  await page.getByRole("button", { name: "Launch session" }).click();

  const terminal = page.getByLabel("Terminal session");
  await expect(terminal).toBeVisible();
  await expect(terminal).toBeInViewport();
  await expect(terminal.getByText(/Connected · controller/)).toBeVisible();

  const input = terminal.locator(".xterm-helper-textarea");
  await expect(input).toBeFocused();
  await page.keyboard.type("echo term-dock-e2e");
  await page.keyboard.press("Enter");

  await expect(terminal.locator(".xterm-screen")).toContainText(
    "preview received: echo term-dock-e2e",
  );
});
