#!/usr/bin/env node
// Granola Filer -- command line entry point.
//
//   node src/cli.js connect [--device]
//   node src/cli.js dry-run [--days N]
//   node src/cli.js run [--days N] [--refile <meetingId>] [--no-toast]
//   node src/cli.js install-schedule | uninstall-schedule
//   node src/cli.js status

import { loadConfig, files, log } from './config.js';

function arg(name, argv) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const configPath = arg('--config', argv);
  const config = loadConfig(configPath || files.config());
  const days = arg('--days', argv);
  if (days) config.lookbackDays = Number(days);

  switch (cmd) {
    case 'connect': {
      const { connect } = await import('./connect.js');
      await connect(config, { device: argv.includes('--device') });
      console.log('\nDone. Next: node src/cli.js dry-run');
      break;
    }
    case 'dry-run':
    case 'run': {
      const { runFiler } = await import('./filer.js');
      const refile = arg('--refile', argv);
      const result = await runFiler(config, {
        dryRun: cmd === 'dry-run',
        refile,
        toast: cmd === 'run' && !argv.includes('--no-toast'),
      });
      console.log(result.message);
      if (result.exitCode) process.exitCode = result.exitCode;
      break;
    }
    case 'install-schedule': {
      const { installSchedule } = await import('./schedule.js');
      console.log(installSchedule(config));
      break;
    }
    case 'uninstall-schedule': {
      const { uninstallSchedule } = await import('./schedule.js');
      console.log(uninstallSchedule());
      break;
    }
    case 'status': {
      const { status } = await import('./filer.js');
      console.log(status(config));
      break;
    }
    case 'discover': {
      const { discover } = await import('./discover.js');
      await discover(config);
      break;
    }
    default:
      console.log(`Granola Filer

Commands:
  connect [--device]        Sign in to Granola (opens your browser).
  dry-run [--days N]        Show what would be filed, in ${files.plan()}
  run [--days N]            File ready meetings and show a notification.
      [--refile <id>]       Re-write one meeting even if it was already filed.
  status                    Show counts from the local state.
  install-schedule          Run "run" every ${config.intervalMinutes} minutes while you are logged on.
  uninstall-schedule        Remove the scheduled task.

Config: ${files.config()}`);
  }
}

main().catch((e) => {
  log(`error: ${e.name}: ${e.message}`);
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
});
