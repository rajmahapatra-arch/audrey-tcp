// Windows toast notification via PowerShell's built-in WinRT bindings (no modules).

import { execFile } from 'node:child_process';

// Windows PowerShell's own AppUserModelID -- lets an unpackaged script raise toasts.
const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

export function toastScript(title, body) {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text></binding></visual></toast>`;
  return `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml('${xml.replace(/'/g, "''")}')
$t = [Windows.UI.Notifications.ToastNotification]::new($x)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show($t)`;
}

/** Show a toast. Never throws; resolves when PowerShell exits. */
export function showToast(title, body) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', toastScript(title, body)],
      { windowsHide: true, timeout: 20000 }, () => resolve());
  });
}

/** "3 meetings filed, 1 waiting to be filed" */
export function toastText({ filed, inbox, newMatters = 0 }) {
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const parts = [`${plural(filed, 'meeting')} filed`];
  if (inbox) parts.push(`${inbox} waiting to be filed`);
  if (newMatters) parts.push(`${plural(newMatters, 'new matter folder')} created`);
  return parts.join(', ');
}
