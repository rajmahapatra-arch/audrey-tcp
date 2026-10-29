// Per-user Windows Task Scheduler task: run `run` every N minutes while Raj is logged on,
// with no visible window (conhost --headless).

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TASK_NAME = 'Granola Filer';

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

export function scheduleScript(config, { nodeExe = process.execPath, cliPath } = {}) {
  const cli = cliPath || path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
  const minutes = Math.max(5, Number(config.intervalMinutes) || 15);
  const args = `--headless "${nodeExe}" "${cli}" run`;
  return `$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ${psq(args)} -WorkingDirectory ${psq(path.dirname(path.dirname(cli)))}
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ${minutes})
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName ${psq(TASK_NAME)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Files new Granola meeting notes into client/matter folders.' -Force | Out-Null
'Scheduled task "${TASK_NAME}" installed: runs every ${minutes} minutes while you are logged on.'`;
}

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8', windowsHide: true,
  }).trim();
}

export function installSchedule(config) {
  return ps(scheduleScript(config));
}

export function uninstallSchedule() {
  return ps(`if (Get-ScheduledTask -TaskName ${psq(TASK_NAME)} -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName ${psq(TASK_NAME)} -Confirm:$false; 'Scheduled task "${TASK_NAME}" removed.'
} else { 'No scheduled task "${TASK_NAME}" found.' }`);
}
