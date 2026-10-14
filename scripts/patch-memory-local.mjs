import fs from 'node:fs';
const p = 'C:/Users/anubh/.config/opencode/agent/loop-free.md';
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
// 1-based indices line1-... inspect boundaries carefully before writing
const start = lines.findIndex((l, i) => i === 177 && l.startsWith('`nova-memory` is required')) ;
console.log('Start candidate', start, start>=0 ? lines[start] : 'not found');
// fallback: find first index containing "is required for repo-level"
let idx = lines.findIndex(l => l.includes('is required for repo-level shared continuity'));
console.log('idx', idx);
if (idx === -1) {
  // try old version
  idx = lines.findIndex(l => l.includes('nova-memory` is required to keep simultaneous sessions'));
}
console.log('idx2', idx);
if (idx !== -1) {
  // remove lines from first `nova-memory` blob to following blank/other
  let end = idx+1;
  while (end < lines.length && lines[end].trim() !== '' && lines[end].includes('UI smoke') === false) end++;
  console.log('end', end, lines[end]);
  const block = [
    '- Multi-session repo continuity → **nova-memory** (mandatory for resuming work across parallel sessions:',
    "  `memory_search` with `project = <repoRoot>` and `store_memory` after any commit/merge, tagging",
    "  `project = <repoRoot>`, `memory_type: context`). If multiple worktrees differ, ask the user which store tag to use;",
    "  never silently guess.",
  ];
  lines.splice(idx, end-idx, ...block);
  fs.writeFileSync(p, lines.join('\n'));
  console.log('rewrote local');
}
