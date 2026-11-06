import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/git.js';
test('built stdio server discovers entrypoints and renders app resource',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'git-workspace-mcp-')); const repo=path.join(root,'repo'), state=path.join(root,'state'); await mkdir(repo);await mkdir(state);await run('git',['init','-b','main'],repo); await writeFile(path.join(state,'config.json'),JSON.stringify({root:repo}));
 const client=new Client({name:'git-workspace-check',version:'1.0.0'});const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/server.js')],env:{...process.env,GIT_WORKSPACE_STATE_DIR:state} as Record<string,string>});
 try {await client.connect(transport);assert.match(client.getServerVersion()?.icons?.[0].src || '', /^data:image\/svg\+xml;base64,/);const tools=await client.listTools();assert.equal(tools.tools.length,3); assert.ok(tools.tools.some(t=>t.name==='git_workspace_panel'));const resource=await client.readResource({uri:`ui://git-workspace/${client.getServerVersion()?.version}/panel.html`});assert.match(String('text' in resource.contents[0] ? resource.contents[0].text : ''),/Сгенерировать/);const result=await client.callTool({name:'git_workspace_action',arguments:{action:'refresh'}});assert.equal((result.structuredContent as Record<string,unknown>)?.ok,true);assert.equal(((result.structuredContent as Record<string,unknown>)?.repos as {name:string}[])[0].name,'repo'); await writeFile(path.join(repo,'example.txt'),'staging preview\n');
 const id=((result.structuredContent as {repos:{id:string}[]}).repos)[0].id;
 const opened=await client.callTool({name:'git_workspace_action',arguments:{action:'file-path',repo:id,file:'example.txt'}});assert.equal((opened.structuredContent as {path:string}).path,await (await import('node:fs/promises')).realpath(path.join(repo,'example.txt')));
 const escape=await client.callTool({name:'git_workspace_action',arguments:{action:'file-path',repo:id,file:'../outside.txt'}});assert.equal((escape.structuredContent as {ok:boolean}).ok,false);
 const staged=await client.callTool({name:'git_workspace_action',arguments:{action:'stage',repo:id}});
 const stagedRepo=(staged.structuredContent as {repo:{files:{index:string;worktree:string}[]}}).repo;
 assert.equal(stagedRepo.files[0].index,'A');assert.equal(stagedRepo.files[0].worktree,' ');
 const preview=await client.callTool({name:'git_workspace_action',arguments:{action:'diff',repo:id,file:'example.txt',staged:true}});assert.match((preview.structuredContent as {diff:string}).diff,/staging preview/);
 const unstaged=await client.callTool({name:'git_workspace_action',arguments:{action:'unstage',repo:id}});assert.equal((unstaged.structuredContent as {repo:{files:{index:string}[]}}).repo.files[0].index,'?');
 const bad=await client.callTool({name:'git_workspace_action',arguments:{action:'stage',repo:'unknown'}});assert.equal((bad.structuredContent as Record<string,unknown>)?.ok,false); } finally {await client.close();await rm(root,{recursive:true,force:true});}
});
