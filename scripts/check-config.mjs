import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync('C:/Anubhav/loop-free/templates/config_root/opencode.jsonc','utf8'));
console.log(JSON.stringify(d.plugins, null, 2));
console.log('serverKeys:', Object.keys(d.mcp.servers));
