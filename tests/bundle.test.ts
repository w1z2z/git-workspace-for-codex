import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
test('HTML preserves bundled JavaScript and parses without syntax errors', async () => {
 const html=await readFile('dist/panel.html','utf8');
 const match=html.match(/<script type="module">([\s\S]*?)<\/script>/);
 assert.ok(match);
 const original=await readFile('dist/app.js','utf8');
 assert.equal(match[1],original.replaceAll('</script','<\\/script'));
 await transform(match[1],{loader:'js',target:'es2022'});
});
