import fs from 'node:fs';
const p = 'C:/Users/anubh/.config/opencode/agent/loop-free.md';
let t = fs.readFileSync(p, 'utf8');
const anchor = '## Frontend vs Backend specialization (mandatory)';
if (!t.includes('## Shared repo memory')) {
  const ins = "## Shared repo memory (nova-memory)\n\nAt stage 0, if a repo root can be identified, inquire for `project=<repoRoot>` using\n`memory_search` and store findings in the handoff; do not assume cross-session state yourself. At PRODUCTIONIZE\n(stage 8), call `store_memory` with a concise outcome summary, `project=<repoRoot>` tag, `memory_type: context`,\nand the commit's `tree` digest or commit SHA so future sessions can rehydrate. For multiple worktrees or git clones,\nalways confirm the store root with the user.\n\n";
  t = t.replace(anchor, ins + anchor);
}
fs.writeFileSync(p, t);
console.log('done');
