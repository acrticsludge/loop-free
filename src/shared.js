import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

export function defaultConfigDir() {
  const home = process.env.USERPROFILE || os.homedir();
  if (process.platform === 'win32') return path.join(home, '.config', 'opencode');
  return path.join(home, '.config', 'opencode');
}

export function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function copyDir(src, dest, force=false) {
  // recursively copy tree using Node fs
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(from, to, force);
    else {
      if (fs.existsSync(to) && !force) return;
      fs.copyFileSync(from, to);
    }
  }
}

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
export function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

export function hydrateTemplateContent(content, cfgDir) {
  return content.replace(/\{\{CONFIG_DIR\}\}/g, cfgDir.replace(/\\/g, '/'));
}

export function replaceRelativePluginPaths(jsonPath, cfgDir) {
  const obj = readJson(jsonPath);
  if (Array.isArray(obj.plugins)) {
    obj.plugins = obj.plugins.map(p => {
      if (typeof p === 'string') return p.replace(/\{\{CONFIG_DIR\}\}/g, cfgDir);
      if (p && p.package) return { ...p, package: String(p.package).replace(/\{\{CONFIG_DIR\}\}/g, cfgDir) };
      return p;
    });
  }
  fs.writeFileSync(jsonPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

export function logSection(t) { console.log(`\n=== ${t} ===`); }
