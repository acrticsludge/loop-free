import fs from 'node:fs';
import path from 'node:path';
import * as S from './shared.js';

export async function runUpgrade(args) {
  S.logSection('loop-free upgrade (sync latest templates into your config)');
  args = args || {};
  args.force = true;
  args.skipConfig = false;
  console.log('1/2) Re-applying templates from this version...');
  const { runInstall } = await import('./install.js');
  await runInstall(args);
  console.log('2/2) Upgrade complete. Non-secret MCP changes/agents now match this version.');
  console.log('   Fill any missing placeholders before proceeding:');
  console.log('   Config root: ' + (S.defaultConfigDir()));
  console.log('   Run doctor: loop-free doctor --yes');
}
