import type { SessionNotification } from "@term-dock/notification-policy";
import { isNativeHost } from "./api";

/** Check without prompting: alerts always remain an explicit user choice. */
export async function desktopAlertsAreEnabled(): Promise<boolean> {
  if (!isNativeHost) return false;
  try {
    const { isPermissionGranted } =
      await import("@tauri-apps/plugin-notification");
    return await isPermissionGranted();
  } catch {
    return false;
  }
}

export async function requestDesktopAlerts(): Promise<boolean> {
  if (!isNativeHost) return false;
  try {
    const { isPermissionGranted, requestPermission } =
      await import("@tauri-apps/plugin-notification");
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/** A last permission check prevents stale UI state from producing a toast. */
export async function sendDesktopAlert(
  notification: SessionNotification,
): Promise<void> {
  if (!isNativeHost) return;
  const { isPermissionGranted, sendNotification } =
    await import("@tauri-apps/plugin-notification");
  if (!(await isPermissionGranted())) return;
  sendNotification({ title: notification.title, body: notification.body });
}
