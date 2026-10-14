#!/usr/bin/env node
import { runInstall } from '../src/install.js';
import { runDoctor } from '../src/doctor.js';
import { runUpgrade } from '../src/upgrade.js';

function help() {
  console.log(`loop-free set up + doctor + upgrade for the free-tier loop-engine stack on OpenCode (Windows-focused)\n\nUsage:\n  loop-free install [--config-dir <path>] [--force] [--yes]\n  loop-free doctor [--config-dir <path>] [--yes]\n  loop-free upgrade [--config-dir <path>] [--yes]\n  loop-free help\n`);
}

function parseArgs(argv) {
  const out = { force: false, skipMcp: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config-dir') out.configDir = argv[++i];
    else if (argv[i] === '--force') out.force = true;
    else if (argv[i] === '--skip-mcp') out.skipMcp = true;
    else if (argv[i] === '--yes') out.yes = true;
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === 'help' || cmd === '--help') {
    help();
    return;
  }
  if (cmd === 'install') {
    await runInstall(parseArgs(args.slice(1)));
  } else if (cmd === 'doctor') {
    await runDoctor(parseArgs(args.slice(1)));
  } else if (cmd === 'upgrade') {
    await runUpgrade(parseArgs(args.slice(1)));
  } else {
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exitCode = 1;
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
