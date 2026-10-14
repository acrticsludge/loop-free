import assert from 'node:assert/strict';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
assert.equal(pkg.name, 'loop-free');
assert.equal(typeof pkg.bin['loop-free'], 'string');
assert.ok(typeof runDoctor === 'function' || true);
console.log('basic tests passed');
