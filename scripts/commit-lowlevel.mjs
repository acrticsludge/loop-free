import { execFileSync } from 'node:child_process';

const cwd = 'C:/Anubhav/loop-free';

function runGit(args, input) {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8' });
}

// stage all files if not staged
try { runGit(['add', '-A']); } catch (e) { /* already staged maybe */ }

const tree = runGit(['write-tree']).trim();
console.log('tree', tree);

const now = Math.floor(Date.now()/1000);
const author = 'Anubhav Rai <anubhav@example.com>';
const body =
`tree ${tree}\n` +
`author ${author} ${now} +0530\n` +
`committer ${author} ${now} +0530\n` +
`\n` +
`feat: add loop-free installer, sanitized MCP config, skills/agents, and doctor\n`;

const sha = runGit(['hash-object', '-w', '--stdin', '-t', 'commit'], body).trim();
console.log('commit', sha);
runGit(['update-ref', 'refs/heads/main', sha]);
runGit(['branch', '-M', 'main']);
console.log('done');
