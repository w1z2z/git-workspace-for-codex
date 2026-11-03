import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace, run } from '../src/git.js';

test('nested repositories, worktree, stage, unstage, generation, hooks, commit and push', async () => {
 const root = await realpath(await mkdtemp(path.join(tmpdir(),'git-workspace-test-')));
 try {
  for (const name of ['front','back']) { const dir=path.join(root,name); await mkdir(dir); await run('git',['init','-b','main'],dir); await run('git',['config','user.name','Test'],dir); await run('git',['config','user.email','test@example.invalid'],dir); await run('git',['config','commit.gpgsign','false'],dir); }
  const front=path.join(root,'front'), back=path.join(root,'back');
  await writeFile(path.join(front,'a.txt'),'one\n'); await run('git',['add','.'],front); await run('git',['commit','-m','initial'],front);
  await run('git',['worktree','add','-b','feature',path.join(root,'worktree')],front);
  await writeFile(path.join(front,'a.txt'),'two\n'); await writeFile(path.join(front,'new file.txt'),'new\n');
  let received=''; const ws=new Workspace(path.join(root,'state'),async diff=>{received=diff;return 'feat: add new file';}); ws.config.root=root; await ws.init();
  assert.equal(ws.repos.size,3); const id=[...ws.repos].find(([,p])=>p===front)![0]; const backId=[...ws.repos].find(([,p])=>p===back)![0];
  assert.equal((await ws.status(id)).files.length,2);
  await ws.stage(id,'new file.txt'); assert.match(await ws.diff(id,'new file.txt',true),/\+new/); assert.doesNotMatch(await ws.diff(id,'new file.txt',true),/\+two/);
  const generation=await ws.startGeneration(id); await new Promise(resolve=>setImmediate(resolve)); assert.equal(ws.job(generation.id).message,'feat: add new file'); assert.match(received,/new file/); assert.doesNotMatch(received,/two/);
  await ws.unstage(id,'new file.txt'); assert.equal((await ws.status(id)).files.find(f=>f.path==='new file.txt')?.index,'?');
  await ws.stage(id,'new file.txt'); const old=await ws.hash(id); await ws.stage(id,'a.txt'); await assert.rejects(ws.commit(id,'wrong',old),/Staging изменился/);
  await ws.unstage(id,'a.txt');
  const hook=path.join(front,'.git/hooks/pre-commit'); await writeFile(hook,'#!/bin/sh\necho "hook denied" >&2\nexit 1\n'); await chmod(hook,0o755);
  await assert.rejects(ws.commit(id,'feat: add new file',await ws.hash(id)),/hook denied/); assert.ok((await ws.status(id)).files.some(f=>f.index==='A'));
  await rm(hook); await ws.commit(id,'feat: add new file',await ws.hash(id)); assert.equal((await ws.status(id)).files.length,1); assert.equal(await readFile(path.join(front,'a.txt'),'utf8'),'two\n');
  const bare=path.join(root,'remote.git'); await run('git',['init','--bare',bare],root); await run('git',['remote','add','origin',bare],front);
  await ws.push(id,'origin','main','main'); assert.equal((await ws.direction(id)).remote,'origin'); assert.equal((await ws.status(id)).upstream,'origin/main');
  await assert.rejects(ws.push(id,'origin','other','main'),/Upstream изменился/);
  const rejectHook=path.join(bare,'hooks/pre-receive'); await writeFile(rejectHook,'#!/bin/sh\necho "remote denied" >&2\nexit 1\n'); await chmod(rejectHook,0o755);
  await ws.stage(id,'a.txt'); await ws.commit(id,'fix: update a',await ws.hash(id)); await assert.rejects(ws.push(id,'origin','main','main'),/remote denied/); assert.equal((await ws.status(id)).outgoing,1);
  await writeFile(path.join(back,'first.txt'),'first'); await ws.stage(backId); await ws.unstage(backId,'first.txt'); assert.equal((await ws.status(backId)).files[0].index,'?');
  await assert.rejects(ws.cwd('unconnected'),/не подключён/);
  let unlock!:()=>void; const wait=ws.locked(id,()=>new Promise<void>(resolve=>{unlock=resolve;})); await new Promise(resolve=>setTimeout(resolve,100)); await assert.rejects(ws.stage(id),/уже выполняется/); unlock(); await wait;
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('generation cancellation and size limit do not alter staging', async () => {
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'git-workspace-cancel-')));
 try {
  const repo=path.join(root,'repo');await mkdir(repo);await run('git',['init','-b','main'],repo);
  const ws=new Workspace(path.join(root,'state'),async (_diff,_lang,_format,signal)=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('cancelled')));}));ws.config.root=root;await ws.init(); const id=[...ws.repos.keys()][0];
  await writeFile(path.join(repo,'small'),'small\n');await ws.stage(id);const hash=await ws.hash(id);const job=await ws.startGeneration(id);assert.equal(ws.job(job.id,true).state,'cancelled');assert.equal(await ws.hash(id),hash);
  await writeFile(path.join(repo,'large'),'a'.repeat(260_000));await ws.stage(id);await assert.rejects(ws.startGeneration(id),/250 КБ/);
  ws.config.drafts[id]='preserved';ws.config.generatedHashes[id]=hash;await ws.save();const restored=new Workspace(ws.stateDir);await restored.init();assert.equal(restored.config.drafts[id],'preserved');assert.equal(restored.config.generatedHashes[id],hash);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('line counts distinguish staged changes and full diff includes unchanged context', async () => {
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'git-workspace-stats-')));
 try {
  const repo=path.join(root,'repo');await mkdir(repo);await run('git',['init','-b','main'],repo);await run('git',['config','user.name','Test'],repo);await run('git',['config','user.email','test@example.invalid'],repo);await run('git',['config','commit.gpgsign','false'],repo);
  const lines=Array.from({length:80},(_,i)=>`line ${i}`);await writeFile(path.join(repo,'Dockerfile'),lines.join('\n')+'\n');await run('git',['add','.'],repo);await run('git',['commit','-m','initial'],repo);
  const ws=new Workspace(path.join(root,'state'));ws.config.root=root;await ws.init();const id=[...ws.repos.keys()][0];lines[40]='updated';await writeFile(path.join(repo,'Dockerfile'),lines.join('\n')+'\n');
  assert.deepEqual((await ws.status(id)).files[0].unstagedStats,{added:1,deleted:1});
  assert.doesNotMatch(await ws.diff(id,'Dockerfile',false),/ line 0\n/);
  const full=await ws.diff(id,'Dockerfile',false,true);assert.match(full,/ line 0\n/);assert.match(full,/ line 79\n/);assert.match(full,/\+updated/);
  await ws.stage(id,'Dockerfile');lines[60]='second update';await writeFile(path.join(repo,'Dockerfile'),lines.join('\n')+'\n');const file=(await ws.status(id)).files[0];assert.deepEqual(file.stagedStats,{added:1,deleted:1});assert.deepEqual(file.unstagedStats,{added:1,deleted:1});
  await run('git',['mv','Dockerfile','renamed\tfile'],repo);assert.deepEqual((await ws.status(id)).files[0].stagedStats,{added:1,deleted:1});
 } finally {await rm(root,{recursive:true,force:true});}
});

test('unstaged generation preserves index, smart commit includes new files, discard preserves other changes', async () => {
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'git-workspace-smart-')));
 try {
  const repo=path.join(root,'repo');await mkdir(repo);await run('git',['init','-b','main'],repo);await run('git',['config','user.name','Test'],repo);await run('git',['config','user.email','test@example.invalid'],repo);await run('git',['config','commit.gpgsign','false'],repo);
  let received='';const ws=new Workspace(path.join(root,'state'),async diff=>{received=diff;return 'fix: update files';});ws.config.root=repo;await ws.init();const id=[...ws.repos.keys()][0];
  await writeFile(path.join(repo,'a.txt'),'original\n');await writeFile(path.join(repo,'b.txt'),'original\n');await run('git',['add','.'],repo);await run('git',['commit','-m','initial'],repo);
  await writeFile(path.join(repo,'a.txt'),'updated\n');await writeFile(path.join(repo,'new.txt'),'new content\n');const originalIndex=await readFile(path.join(repo,'.git/index'));
  const generation=await ws.startGeneration(id);await new Promise(resolve=>setImmediate(resolve));assert.equal(ws.job(generation.id).state,'done');assert.match(received,/updated/);assert.match(received,/new content/);assert.deepEqual(await readFile(path.join(repo,'.git/index')),originalIndex);
  await writeFile(path.join(repo,'new.txt'),'changed after generation\n');await assert.rejects(ws.commit(id,'stale',generation.hash),/изменились файлы/);assert.equal(await ws.git(id,['diff','--cached']),'');
  await ws.commit(id,'fix: update files',(await ws.status(id)).changesHash!);assert.equal((await ws.status(id)).files.length,0);
  await writeFile(path.join(repo,'a.txt'),'discard this\n');await ws.stage(id,'a.txt');await writeFile(path.join(repo,'a.txt'),'discard this too\n');await writeFile(path.join(repo,'b.txt'),'keep this\n');await ws.stage(id,'b.txt');
  await ws.discard(id,'a.txt');assert.equal(await readFile(path.join(repo,'a.txt'),'utf8'),'updated\n');assert.equal(await readFile(path.join(repo,'b.txt'),'utf8'),'keep this\n');assert.ok((await ws.status(id)).files.find(file=>file.path==='b.txt')?.index==='M');assert.match(await ws.git(id,['stash','list']),/Git Workspace/);
  await writeFile(path.join(repo,'scratch.txt'),'backup new file');await ws.discard(id,'scratch.txt');assert.ok(!(await ws.status(id)).files.some(file=>file.path==='scratch.txt'));
  await ws.commit(id,'fix: keep b',(await ws.status(id)).changesHash!);await assert.rejects(ws.startGeneration(id),/Нет изменений/);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('generation reuses an unchanged diff and unstage all preserves file contents', async () => {
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'git-workspace-cache-')));
 try {
  const repo=path.join(root,'repo');await mkdir(repo);await run('git',['init','-b','main'],repo);
  let calls=0;const ws=new Workspace(path.join(root,'state'),async()=>{calls++;return 'feat: add example';});ws.config.root=repo;await ws.init();const id=[...ws.repos.keys()][0];
  await writeFile(path.join(repo,'example.txt'),'new text\n');
  const first=await ws.startGeneration(id);await new Promise(resolve=>setImmediate(resolve));const second=await ws.startGeneration(id);assert.equal(second.id,first.id);assert.equal(calls,1);
  ws.config.language='Русский';await ws.startGeneration(id);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);
  assert.equal(await ws.file(id,'example.txt'),'new text\n');
  await ws.stage(id);await ws.unstage(id);assert.equal((await ws.status(id)).files[0].index,'?');assert.equal(await readFile(path.join(repo,'example.txt'),'utf8'),'new text\n');
  await writeFile(path.join(repo,'example.txt'),'updated text\n');await ws.startGeneration(id);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,3);
  await run('git',['config','user.name','Test'],repo);await run('git',['config','user.email','test@example.invalid'],repo);await run('git',['config','commit.gpgsign','false'],repo);await ws.stage(id);await ws.commit(id,'initial',await ws.hash(id));
  await writeFile(path.join(repo,'example.txt'),'third text\n');await writeFile(path.join(repo,'new.txt'),'another file\n');await ws.stage(id);await ws.unstage(id);const files=(await ws.status(id)).files;assert.ok(files.every(file=>[' ','?'].includes(file.index)));assert.equal(await ws.file(id,'example.txt'),'third text\n');
 } finally {await rm(root,{recursive:true,force:true});}
});

test('create repository in selected root and connect a GitHub origin safely', async () => {
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'git-workspace-init-')));
 try {
  await writeFile(path.join(root,'README.md'),'project files stay untouched\n');
  const ws=new Workspace(path.join(root,'state'));ws.config.root=root;await ws.init();assert.equal(ws.repos.size,0);
  const snapshot=await ws.initRepository();assert.equal(snapshot.repos.length,1);assert.equal(snapshot.repos[0].name,path.basename(root));
  const id=snapshot.repos[0].id;assert.equal((await ws.status(id)).files[0].path,'README.md');
  const direction=await ws.addOrigin(id,'https://github.com/example/project.git');assert.equal(direction.remotes[0],'origin');assert.equal(direction.url,'https://github.com/example/project.git');
  await assert.rejects(ws.addOrigin(id,'https://github.com/other/project.git'),/уже настроен/);
  await assert.rejects(ws.addOrigin(id,'https://user:password@github.com/example/project.git'),/без встроенного пароля/);
  await assert.rejects(ws.initRepository(),/уже найдены/);
  assert.equal(await readFile(path.join(root,'README.md'),'utf8'),'project files stay untouched\n');
 } finally {await rm(root,{recursive:true,force:true});}
});

test('generation respects saved model and does not reuse another model result', async () => {
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'git-workspace-model-')));
 try {
  const repo=path.join(root,'repo');await mkdir(repo);await run('git',['init','-b','main'],repo);await writeFile(path.join(repo,'example'),'new\n');
  const seen:string[]=[];const ws=new Workspace(path.join(root,'state'),async (_diff,_language,_format,_signal,model)=>{seen.push(model || '');return 'feat: example';});ws.config.root=repo;await ws.init();const id=[...ws.repos.keys()][0];
  const first=await ws.startGeneration(id);await new Promise(resolve=>setImmediate(resolve));assert.equal(ws.job(first.id).state,'done');
  ws.config.model='gpt-6.1-sol';await ws.save();const second=await ws.startGeneration(id);await new Promise(resolve=>setImmediate(resolve));assert.notEqual(second.id,first.id);assert.deepEqual(seen,['gpt-6-luna','gpt-6.1-sol']);
  const restored=new Workspace(ws.stateDir);await restored.init();assert.equal(restored.config.model,'gpt-6.1-sol');
 } finally {await rm(root,{recursive:true,force:true});}
});
