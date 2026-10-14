import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import * as S from './shared.js';
import manifest from '../manifest.json' with { type: 'json' };

export async function runDoctor(args={}) {
  const cfgDir = args.configDir ? path.resolve(args.configDir) : S.defaultConfigDir();
  const jsonPath = path.join(cfgDir, 'opencode.jsonc');
  const quiet = !!args.quiet;

  if (!quiet) S.logSection('loop-free doctor');

  // 1. OpenCode binary available
  let opencodeAvailable = false;
  try { execSync('opencode --version', { stdio: 'ignore' }); opencodeAvailable = true; } catch(e) {}
  console.log('opencode CLI:', opencodeAvailable ? 'installed' : 'MISSING (required)');

  // 2. Required skills existence
  S.logSection('Skills');
  for (const sk of manifest.requiredSkills) {
    const installed = fs.existsSync(path.join(cfgDir, 'skill', sk, 'SKILL.md')) ||
                       fs.existsSync(path.join(cfgDir, 'skill', sk));
    console.log(mp(installed) + ` ${sk}  ${installed ? '' : '(install via skill package / manual)'}`);
  }

  // 3. Required MCP server configs
  S.logSection('MCP configuration presence');
  const config = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  for (const name of [...manifest.requiredMcp, ...manifest.optionalMcp]) {
    const srv = config.mcp?.servers?.[name];
    const present = !!srv;
    const hasPlaceholder = srv ? needsSecret(srv) : true;
    console.log(mp(present) + ` ${name} config: ${present ? (hasPlaceholder ? 'placeholder not yet set' : 'ready') : 'MISSING'}`);
  }

  // 4. Live connection check
  S.logSection('MCP connection status (opencode mcp list)');
  let listText = '';
  try {
    listText = execSync('opencode mcp list', { encoding: 'utf8', timeout: 60000 });
    console.log(listText.trim());
  } catch (e) {
    console.log('Failed to run `opencode mcp list`. Did OpenCode finish installing?');
    listText = e.stdout || e.stderr || '';
    console.log(listText);
  }
  const connected = parseConnected(listText);
  const failed = parseFailed(listText);

  S.logSection('Missing / not ready (action required)');
  const missingMcp = [...manifest.requiredMcp, ...manifest.optionalMcp].filter(m => !connected.includes(m));
  console.log('Not currently connected MCPs: ' + (missingMcp.length ? missingMcp.join(', ') : '(none)'));

  // Skills not present:
  const missingSkills = manifest.requiredSkills.filter(sk => !(fs.existsSync(path.join(cfgDir, 'skill', sk, 'SKILL.md'))));
  for (const sk of missingSkills) {
    console.log('Missing skill: ' + sk);
  }

  // Env vars unaddressed (aka placeholders)
  const missingEnv = manifest.envVars.filter(e => {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    return raw.includes(e.placeholder);
  });
  if (missingEnv.length) {
    console.log('Placeholders still in config (fill these):');
    for (const e of missingEnv) console.log('  - ' + e.key + ' (' + e.placeholder + ')');
  }

  console.log('\nSteps:');
  console.log('  - Fill placeholders inside: ' + jsonPath);
  console.log('  - Run: opencode mcp auth <server>  for OAuth servers: vercel, postman, sentry');
  console.log('  - Verify final: loop-free doctor');
  console.log('');

  if (!quiet && !args?.yes && missingMcp.length > 0) {
    await S.ask('Press Enter after connecting/checking missing MCPs, or q to exit: ').then(a => { if (a.trim().toLowerCase()==='q') process.exit(0); });
  }
}

function mp(ok) { return ok ? '✓' : '✗'; }

function needsSecret(srv) {
  const raw = JSON.stringify(srv);
  return /\bYOUR_.*_KEY\b/.test(raw) || raw.includes('YOUR_GITHUB_PAT') || raw.includes('YOUR_POSTIZ_API_KEY') || raw.includes('YOUR_FIGMA_API_KEY');
}

function parseConnected(t) {
  const res = [];
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(/[✓✔]\s+([A-Za-z0-9_-]+)\s+connected/);
    if (m) res.push(m[1]);
  }
  return res;
}
function parseFailed(t) {
  const res = [];
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(/[✗✖]\s+([A-Za-z0-9_-]+)\s+failed/);
    if (m) res.push(m[1]);
  }
  return res;
}
