import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const projectRoot = path.join(packageRoot, 'templates');

export async function runInstall(args) {
  const cfgDir = args.configDir ? path.resolve(args.configDir) : S.defaultConfigDir();
  const force = !!args.force;
  console.log(`Install target: ${cfgDir}`);
  S.ensureDir(cfgDir);

  // 1. Copy templates.
  const layers = [
    'agent', 'command', 'loop', 'plugins', 'tui-plugins', 'skill', 'config_root'
  ];
  for (const layer of layers) {
    const src = path.join(projectRoot, layer);
    const dest = layer === 'config_root' ? cfgDir : path.join(cfgDir, layer);
    S.copyDir(src, dest, force);
  }
  // AGENTS.md
  copyFileIf(projectRoot, cfgDir, 'AGENTS.md', force);
  // config_root already copied opencode.jsonc into cfgDir
  // template config_root has opencode.jsonc (sanitized)
  // Hydrate opencode.jsonc plugins + other placeholders
  const jsonPath = path.join(cfgDir, 'opencode.jsonc');
  if (fs.existsSync(jsonPath)) {
    // config_root template got copied already into cfgDir root
  }
  const templateCfg = path.join(projectRoot, 'config_root', 'opencode.jsonc');
  if (!fs.existsSync(jsonPath)) {
    fs.copyFileSync(templateCfg, jsonPath);
  }
  // Ensure template replaced placeholders with cfgDir for plugins (hydrate in existing file)
  // We'll re-run replacement on the active cfg
  S.replaceRelativePluginPaths(jsonPath, cfgDir);
  // Note: {{CONFIG_DIR}} inside opencode.jsonc is mostly in plugins and maybe no string interpolation.
  let content = fs.readFileSync(jsonPath, 'utf8');
  content = content.replace(/\{\{CONFIG_DIR\}\}/g, cfgDir.replace(/\\/g, '/'));
  fs.writeFileSync(jsonPath, content);

  copyFileIf(projectRoot, cfgDir, '../.env.example', force); // optional

  console.log('✓ Templates copied and opencode.jsonc prepared');

  // 2. Prompt user to add credentials + MCPs + skills
  await promptSetup(cfgDir, args);

  // 3. Doctor check
  const { runDoctor } = await import('./doctor.js');
  await runDoctor({ configDir: cfgDir, quiet: false, yes: !!args.yes });
}

function copyFileIf(base, dest, relative, force) {
  const src = path.resolve(base, relative);
  if (!fs.existsSync(src)) return;
  const target = path.join(dest, path.basename(relative));
  if (fs.existsSync(target) && !force) return;
  S.ensureDir(path.dirname(target));
  fs.copyFileSync(src, target);
}

async function promptSetup(cfgDir, args={}) {
  if (args.yes) {
    console.log('Non-interactive mode; skipping credential prompts.');
    return;
  }
  S.logSection('Post-install setup prompts');
  console.log('OpenCode continues in the background. You must provide a few secrets for MCPs to work.');
  const rc = await S.ask('Open the config now to explain? (Enter/n) ');
  console.log(`\nConfig location: ${path.join(cfgDir, 'opencode.jsonc')}\n`);

  const need = [
    ['context7', 'Context7 API key -> template. Authorization: "Bearer YOUR_CONTEXT7_API_KEY"'],
    ['github', 'GitHub PAT (fine-grained) -> Authorization: "Bearer YOUR_GITHUB_PAT"'],
    ['postiz', 'Postiz key (if self-hosted) -> "YOUR_POSTIZ_API_KEY"'],
    ['Framelink_Figma_MCP', 'Figma API key -> "--figma-api-key=YOUR_FIGMA_API_KEY"'],
  ];
  for (const [n, msg] of need) {
    const a = (await S.ask(`Do you plan to use ${n}? (y/N) `)).trim().toLowerCase();
    if (a === 'y') console.log('  guidance -> ' + msg);
  }

  console.log('\nRequired skills (missing ones will be listed below).');
  const addMore = await S.ask('Press Enter after you have updated the placeholders / MCP config, or q to quit: ');
  if (addMore.trim().toLowerCase() === 'q') process.exit(0);
}
