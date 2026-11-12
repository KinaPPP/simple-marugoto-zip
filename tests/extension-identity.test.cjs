'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'..','manifest.json'),'utf8'));
assert.equal(manifest.version,'1.3.13');
assert.equal(Object.hasOwn(manifest,'key'),false,'timing comparison must keep v1.3.5 path-based identity');
console.log('PASS timing comparison: no forced ID; same path retains v1.3.5 identity');
