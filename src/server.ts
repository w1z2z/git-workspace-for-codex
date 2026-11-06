import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { OpenAIExtensions } from '@openai/mcp-extensions/server';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { Workspace } from './git.js';
const workspace = new Workspace(process.env.GIT_WORKSPACE_STATE_DIR);
await workspace.init();
const icons = [{ src: 'data:image/svg+xml;base64,' + (await readFile(new URL('../assets/icon.svg', import.meta.url))).toString('base64'), mimeType: 'image/svg+xml', sizes: ['64x64'] }];
const server = new McpServer({ name: 'Git Workspace', version: '1.7.11', icons });
new OpenAIExtensions(server);
const uri = 'ui://git-workspace/1.7.11/panel.html';
const result = (value: Record<string, unknown>) => ({ content: [] as { type: 'text'; text: string }[], structuredContent: value });
registerAppResource(server, 'Git Workspace', uri, {}, async () => ({ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: await readFile(new URL('./panel.html', import.meta.url), 'utf8'), _meta: { 'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] }, ui: { csp: { connectDomains: [], resourceDomains: [] } } } }] }));
for (const [name, type] of [['git_workspace_open', 'global'], ['git_workspace_panel', 'thread']] as const) registerAppTool(server, name, { title: 'Git Workspace', description: 'Открыть Source Control для подключённых локальных репозиториев.', inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false }, _meta: { ui: { resourceUri: uri }, 'openai/ui': { entrypoints: [{ type }] } } }, async () => result(await workspace.snapshot()));
server.registerTool('git_workspace_action', {
  title: 'Git Workspace action', description: 'Действия панели Git Workspace. Изменяющие действия выполняются только по явному выбору пользователя.',
  inputSchema: { action: z.enum(['refresh', 'history', 'history-files', 'history-diff', 'diff', 'file', 'file-path', 'stage', 'unstage', 'discard', 'draft', 'settings', 'generate', 'job', 'cancel', 'commit', 'direction', 'push', 'init_repository', 'add_origin', 'choose_root']), repo: z.string().optional(), file: z.string().optional(), staged: z.boolean().optional(), full: z.boolean().optional(), message: z.string().optional(), hash: z.string().optional(), job: z.string().optional(), root: z.string().optional(), language: z.string().max(80).optional(), format: z.string().max(120).optional(), uiLanguage: z.enum(['en', 'ru']).optional(), model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).optional(), remote: z.string().optional(), branch: z.string().optional(), historyAll: z.boolean().optional(), historyLimit: z.number().int().min(1).max(2000).optional(), expectedBranch: z.string().optional(), url: z.string().max(2048).optional() },
  _meta: { ui: { visibility: ['app'] } }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async args => {
  try {
    const id = args.repo || ''; let payload: object = {};
    switch (args.action) {
      case 'history': payload = await workspace.history(id, args.branch, args.historyLimit ?? 100, args.historyAll); break;
      case 'history-files': payload = await workspace.commitChanges(id, args.hash || ''); break;
      case 'history-diff':
        if (!args.file) throw new Error('Выберите файл');
        payload = await workspace.commitChanges(id, args.hash || '', args.file);
        break;
      case 'refresh': payload = await workspace.snapshot(); break;
      case 'file-path': payload = { path: await workspace.filePath(id, args.file || '') }; break;
      case 'file': payload = { diff: await workspace.file(id, args.file || '') }; break;
      case 'diff': payload = { diff: await workspace.diff(id, args.file || '', !!args.staged, !!args.full) }; break;
      case 'stage': await workspace.stage(id, args.file); payload = { repo: await workspace.status(id) }; break;
      case 'unstage': await workspace.unstage(id, args.file); payload = { repo: await workspace.status(id) }; break;
      case 'draft': await workspace.cwd(id); workspace.config.drafts[id] = args.message || ''; if (args.hash) workspace.config.generatedHashes[id] = args.hash; if (!args.message) delete workspace.config.generatedHashes[id]; await workspace.save(); break;
      case 'settings': workspace.config.language = args.language || 'English'; workspace.config.format = args.format || 'Conventional Commit'; workspace.config.model = args.model || 'gpt-6-luna'; workspace.config.uiLanguage = args.uiLanguage || 'en'; await workspace.save(); break;
      case 'init_repository': payload = await workspace.initRepository(); break;
      case 'add_origin': payload = await workspace.addOrigin(id, args.url || ''); break;
      case 'choose_root': {
        let root = args.root;
        if (!root) { const { run } = await import('./git.js'); root = (await run('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "Выберите корневую папку workspace")'], '/tmp')).trim(); }
        const previous = workspace.config.root; workspace.config.root = root;
        try { await workspace.discover(); await workspace.save(); } catch (error) { workspace.config.root = previous; await workspace.discover(); throw error; }
        payload = await workspace.snapshot(); break;
      }
      case 'discard': payload = { output: await workspace.discard(id, args.file || '') }; break;
      case 'generate': payload = await workspace.startGeneration(id); break;
      case 'job': payload = workspace.job(args.job || ''); break;
      case 'cancel': payload = workspace.job(args.job || '', true); break;
      case 'commit': payload = { output: await workspace.commit(id, args.message || '', args.hash || '') }; break;
      case 'direction': payload = await workspace.direction(id); break;
      case 'push': payload = { output: await workspace.push(id, args.remote || '', args.branch || '', args.expectedBranch || '') }; break;
    }
    return result({ ok: true, ...payload });
  } catch (error) { console.error('Git Workspace:', String(error)); return result({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});
await server.connect(new StdioServerTransport());
