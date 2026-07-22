import { spawnSync } from "node:child_process";

export const GIVE_UP_TITLE = "frogprogsy watchdog";
export const GIVE_UP_MESSAGE =
  "frogprogsy proxy crashed and could not auto-restart. Run frogp start to bring it back (shows the error). Status: frogp status";

/**
 * Pure function — returns the argv array needed to fire a desktop notification
 * on the given platform. Never throws; callers that need a best-effort side
 * effect use notify() instead.
 */
export function buildNotifyCommand(
  platform: NodeJS.Platform,
  title: string,
  message: string,
): string[] {
  // Escape single-quote-sensitive characters for AppleScript strings
  const escapeAppleScript = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  switch (platform) {
    case "darwin":
      return [
        "osascript",
        "-e",
        `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`,
      ];
    case "linux":
      return ["notify-send", title, message];
    case "win32": {
      // PowerShell WinRT toast (works without external deps on Win 8+)
      const ps = [
        `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null`,
        `$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02`,
        `$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)`,
        `$nodes = $xml.GetElementsByTagName('text')`,
        `$nodes[0].AppendChild($xml.CreateTextNode(${JSON.stringify(title)})) | Out-Null`,
        `$nodes[1].AppendChild($xml.CreateTextNode(${JSON.stringify(message)})) | Out-Null`,
        `$toastXml = [Windows.Data.Xml.Dom.XmlDocument]::new()`,
        `$toastXml.LoadXml($xml.GetXml())`,
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('frogprogsy').Show([Windows.UI.Notifications.ToastNotification]::new($toastXml))`,
      ].join("; ");
      return ["powershell", "-NonInteractive", "-Command", ps];
    }
    default:
      // Unsupported platform — return a no-op command
      return ["echo", `[frogprogsy] ${title}: ${message}`];
  }
}

/**
 * Impure best-effort notification — fires and forgets; all failures are
 * silently swallowed so the caller's control flow is never interrupted.
 */
export function notify(title: string, message: string): void {
  try {
    const argv = buildNotifyCommand(process.platform, title, message);
    if (!argv.length) return;
    spawnSync(argv[0], argv.slice(1), { timeout: 5000, stdio: "ignore" });
  } catch {
    // best-effort — swallow all failures
  }
}
