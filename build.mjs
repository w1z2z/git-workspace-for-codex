import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:['src/server.ts'],outfile:'dist/server.js',bundle:true,platform:'node',format:'esm',banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"},target:'node22'});
await build({entryPoints:['src/app.ts'],outfile:'dist/app.js',bundle:true,platform:'browser',format:'esm',target:'es2022'});
const html=await readFile('src/app.html','utf8'),js=await readFile('dist/app.js','utf8'),css=await readFile('dist/app.css','utf8');
await writeFile('dist/panel.html',html.replace('</head>',()=>`<style>${css}</style></head>`).replace('</body>',()=>`<script type="module">${js.replaceAll('</script','<\\/script')}</script></body>`));
