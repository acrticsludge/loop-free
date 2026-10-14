import fs from 'node:fs';

const p = 'C:/Anubhav/loop-free/templates/config_root/opencode.jsonc';
let s = fs.readFileSync(p, 'utf8');

s = s.replace(/ctx7sk-[0-9a-f-]+/g, 'YOUR_CONTEXT7_API_KEY');
s = s.replace(/218b84a0c856f32fd2bcfd3a2e4b6dbf87990709a701071e0aaac0a2a485a2b3/g, 'YOUR_POSTIZ_API_KEY');
s = s.replace(/figd_[A-Za-z0-9_-]+/g, 'YOUR_FIGMA_API_KEY');
s = s.replace(/github_pat_[A-Za-z0-9_]+/g, 'YOUR_GITHUB_PAT');
s = s.replace(/"plugins": \[\s+\{\s+"package": "C:\\\\Users\\\\anubh\\\\\.config\\\\opencode\\\\tui-plugins\\\\tok-speed"\s+\},\s+\{\s+"package": "C:\\\\Users\\\\anubh\\\\\.config\\\\opencode\\\\tui-plugins\\\\loop-models"\s+\}\s+\]/,
  '"plugins": [\n    { "package": "{{CONFIG_DIR}}/tui-plugins/tok-speed" },\n    { "package": "{{CONFIG_DIR}}/tui-plugins/loop-models" }\n  ]');
// add a comment not JSON valid? comments not allowed; keep placeholder.

fs.writeFileSync(p, s);
console.log('sanitized');
