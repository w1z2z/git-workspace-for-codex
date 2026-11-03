import { t, initI18n, setUiLanguage } from './i18n.js';
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import '@openai/mcp-extensions/app/styles.css';
import './style.css';
import type { Repo } from './git.js';
type Snapshot = {
    repos: Repo[];
    models?: {
        id: string;
        name: string;
    }[];
    config: {
        root: string;
        language: string;
        format: string;
        model: string;
        uiLanguage: 'en' | 'ru';
        drafts: Record<string, string>;
        generatedHashes: Record<string, string>;
    };
};
type Direction = {
    branch: string;
    remote: string;
    ref: string;
    remotes: string[];
    url: string;
};
const app = new App({ name: 'Git Workspace', version: '1.5.3' });
const extensions = new OpenAIExtensions(app);
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const buttonIds = ['stageAll', 'commit', 'commitPush', 'push', 'generate'];
let snapshot: Snapshot | undefined, selected = '', busy = false, refreshing = false, selection = { file: '', staged: false }, diffText = '', jobId = '', generationRepo = '';
const drafts = new Map<string, string>(), generated = new Map<string, string>();
let fullFile = false, repoMenuSignature = '', remoteInfo: Direction | undefined, remoteInfoRepo = '';
const pendingPush = new Set<string>();
let operation = '';
const mainIsPush = () => !!current() && !current()!.files.length && (pendingPush.has(selected) || current()!.outgoing > 0);
let draftTimer: ReturnType<typeof setTimeout> | undefined;
const message = el<HTMLTextAreaElement>('message');
const notice = (text: string, error = false) => { el('notice').textContent = t(text); el('notice').className = error ? 'error' : ''; };
async function call<T extends object = Record<string, unknown>>(action: string, args: object = {}): Promise<T> { const response = await app.callServerTool({ name: 'git_workspace_action', arguments: { action, ...args } }); const data = response.structuredContent as ({
    ok: boolean;
    error?: string;
} & T) | undefined; if (!data?.ok)
    throw new Error(data?.error || t('Сервер не вернул результат')); return data; }
const current = () => snapshot?.repos.find(r => r.id === selected);
function renderRemote() {
    const repo = current(), status = el('remoteStatus'), button = el<HTMLButtonElement>('connectRemote');
    const info = remoteInfoRepo === selected ? remoteInfo : undefined;
    status.textContent = !repo ? '' : !info ? t('Проверка remote…') : info.remotes.includes('origin') ? t('GitHub remote подключён') : t('GitHub не подключён');
    status.title = info?.url || '';
    button.hidden = !repo || !!repo.error || !info || info.remotes.includes('origin');
    button.disabled = busy || !repo || !!repo.error;
}
async function loadRemoteInfo() {
    const id = selected;
    if (remoteInfoRepo === id && remoteInfo)
        return;
    remoteInfo = undefined;
    remoteInfoRepo = id;
    renderRemote();
    if (!id)
        return;
    try {
        const info = await call<Direction>('direction', { repo: id });
        if (id === selected) {
            remoteInfo = info;
            renderRemote();
        }
    }
    catch (error) {
        if (id === selected) {
            remoteInfo = undefined;
            renderRemote();
            notice(String(error), true);
        }
    }
}
function controls() {
    const repo = current(), changes = !!repo?.files.length, invalid = !repo || !!repo.error;
    for (const id of buttonIds)
        el<HTMLButtonElement>(id).disabled = busy || invalid || (id === 'generate' && !!jobId) || (id === 'stageAll' && !changes) || (id === 'commitPush' && !changes);
    el<HTMLButtonElement>('commit').disabled = busy || invalid || (!mainIsPush() && !changes);
    el('commit').innerHTML = t(`<span>${mainIsPush() ? 'Push' : 'Commit'}</span>${operation ? t('<span class="spinner" aria-label="Выполняется"></span>') : ''}`);
    for (const button of Array.from(el('repos').querySelectorAll('button')))
        button.disabled = busy;
    el<HTMLButtonElement>('root').disabled = busy || !!jobId;
    message.disabled = busy;
    el('cancel').hidden = !jobId;
    el('operationLoader').hidden = true;
    el<HTMLButtonElement>('remoteConfirm').disabled = busy;
    renderRemote();
    el('generate').innerHTML = jobId ? '<span class="spinner"></span>' : icons.sparkle;
    el('generate').setAttribute('aria-label', t('Сгенерировать сообщение'));
    el('generate').title = t(`Сгенерировать сообщение · ${snapshot?.config.model || 'gpt-6-luna'}`);
    el('stale').textContent = generated.has(selected) && generated.get(selected) !== (repo?.changesHash || repo?.stagedHash) ? t('Изменения обновились — проверьте сообщение') : '';
}
async function action(task: () => Promise<void>, label = '') {
    if (busy)
        return;
    el<HTMLDetailsElement>('commitMenu').open = false;
    busy = true;
    operation = label;
    controls();
    try {
        await task();
    }
    catch (error) {
        notice(String(error), true);
    }
    finally {
        await refresh();
        busy = false;
        operation = '';
        render();
    }
}
const svg = (body: string) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const icons = {
    plus: svg('<path d="M12 5v14M5 12h14"/>'), minus: svg('<path d="M5 12h14"/>'),
    discard: svg('<path d="M4 10h10a6 6 0 1 1-5.5 8M4 10l5-5M4 10l5 5"/>'),
    open: svg('<path d="M14 3h7v7M21 3l-9 9M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>'),
    sparkle: svg('<path d="m10 2 2.3 6.7L19 11l-6.7 2.3L10 20l-2.3-6.7L1 11l6.7-2.3L10 2zM19 15l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3z"/>'),
};
function iconButton(icon: string, label: string, handler: () => void) {
    const button = document.createElement('button');
    button.className = 'action icon-button';
    button.innerHTML = icon;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = busy;
    button.onclick = handler;
    return button;
}
function render() {
    if (!snapshot)
        return;
    if (!snapshot.repos.some(r => r.id === selected))
        selected = snapshot.repos[0]?.id || '';
    const repo = current();
    el('repoLabel').textContent = repo ? `${repo.name} · ${repo.branch}` : snapshot.repos.length ? t('Выберите репозиторий') : t('Нет репозитория');
    const signature = JSON.stringify([selected, busy, snapshot.repos.map(r => [r.id, r.name, r.branch, r.files.length, r.error])]);
    if (signature !== repoMenuSignature) {
        repoMenuSignature = signature;
        const menu = el('repos');
        menu.replaceChildren();
        for (const item of snapshot.repos) {
            const button = document.createElement('button');
            button.className = 'repo-option';
            button.setAttribute('aria-pressed', String(item.id === selected));
            const name = document.createElement('strong');
            name.textContent = item.name;
            const branch = document.createElement('span');
            branch.textContent = item.branch;
            const count = document.createElement('span');
            count.className = 'badge';
            count.textContent = item.error ? '!' : String(item.files.length);
            button.append(name, branch, count);
            button.onclick = () => { selected = item.id; message.value = drafts.get(selected) || ''; selection = { file: '', staged: false }; diffText = ''; remoteInfo = undefined; (el('repoPicker') as HTMLDetailsElement).open = false; render(); void loadRemoteInfo(); void showDiff().catch(e => notice(String(e), true)); };
            menu.append(button);
        }
        if (!snapshot.repos.length) {
            const create = document.createElement('button');
            create.className = 'repo-option repo-create';
            create.textContent = snapshot.config.root ? t('Создать репозиторий в этой папке') : t('Выбрать папку…');
            create.onclick = () => { if (!snapshot?.config.root) {
                (el('repoPicker') as HTMLDetailsElement).open = false;
                el('root').click();
                return;
            } (el('repoPicker') as HTMLDetailsElement).open = false; void action(async () => { snapshot = await call<Snapshot>('init_repository'); selected = snapshot.repos[0]?.id || ''; message.value = drafts.get(selected) || ''; selection = { file: '', staged: false }; diffText = ''; notice(t('Git-репозиторий создан')); }); };
            menu.append(create);
        }
    }
    el('rootPath').textContent = snapshot.config.root;
    el('rootPath').title = snapshot.config.root;
    el('branch').textContent = repo ? t(`${repo.upstream || t('Upstream не настроен')}  ·  ↓ ${repo.incoming}  ↑ ${repo.outgoing}`) : '';
    el('branch').title = t('Сравнение с локальным состоянием upstream. Автоматический fetch не выполняется.');
    renderRemote();
    const prepared = repo?.files.filter(f => !f.conflict && ![' ', '?'].includes(f.index)).length || 0;
    el('commitHint').textContent = prepared ? t(`В коммит ${repo?.name}: ${prepared} файл(ов)`) : repo?.files.length ? t('Без staging в Commit войдут все Changes') : t('Нет изменений для коммита');
    const list = el('files');
    const scroll = list.scrollTop;
    list.replaceChildren();
    if (repo?.error)
        notice(repo.error, true);
    const groups = [[t('Конфликты'), (f: Repo['files'][number]) => f.conflict, false], ['Staged Changes', (f: Repo['files'][number]) => !f.conflict && ![' ', '?'].includes(f.index), true], ['Changes', (f: Repo['files'][number]) => !f.conflict && (f.index === '?' || ![' ', '?'].includes(f.worktree)), false]] as const;
    for (const [title, match, staged] of groups) {
        const files = repo?.files.filter(match) || [];
        if (!files.length)
            continue;
        const heading = document.createElement('h4');
        heading.textContent = `${title} · ${files.length}`;
        heading.title = staged ? t('Эти изменения войдут в следующий коммит') : title === t('Конфликты') ? t('Сначала разрешите конфликты в редакторе') : t('Эти изменения пока не войдут в коммит');
        if (staged)
            heading.append(iconButton(icons.minus, 'Unstage All Changes', () => void action(async () => { await call('unstage', { repo: selected }); selection.staged = false; notice(t('Все файлы возвращены в Changes')); })));
        list.append(heading);
        for (const file of files) {
            const row = document.createElement('div');
            row.className = 'file' + (selection.file === file.path && selection.staged === staged ? ' active' : '');
            const name = document.createElement('button');
            name.className = 'name';
            name.title = t(`Показать diff: ${file.path}`);
            const basename = document.createElement('span');
            basename.textContent = file.path.split('/').pop() || file.path;
            const folder = document.createElement('small');
            folder.textContent = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : file.index === '?' ? t('Новый файл') : '';
            name.append(basename, folder);
            name.onclick = () => { selection = { file: file.path, staged }; diffText = ''; render(); void showDiff().catch(e => notice(String(e), true)); };
            const stats = staged ? file.stagedStats : file.unstagedStats;
            const count = document.createElement('span');
            count.className = 'file-stats';
            if (stats && stats.added !== null && stats.deleted !== null) {
                const added = document.createElement('span');
                added.className = 'plus';
                added.textContent = `+${stats.added}`;
                const removed = document.createElement('span');
                removed.className = 'minus';
                removed.textContent = `−${stats.deleted}`;
                count.append(added, removed);
                count.title = t('Добавленные и удалённые строки');
            }
            else {
                count.textContent = stats ? 'binary' : file.conflict ? '!' : file.index === '?' ? t('новый') : '';
            }
            const change = iconButton(staged ? icons.minus : icons.plus, staged ? 'Unstage Changes' : 'Stage Changes', () => void action(async () => {
                await call(staged ? 'unstage' : 'stage', { repo: selected, file: file.path });
                if (selection.file === file.path)
                    selection.staged = !staged;
            }));
            change.disabled = busy || file.conflict;
            const open = iconButton(icons.open, staged ? 'Open Staged Changes' : 'Open File', () => {
                if (staged) {
                    selection = { file: file.path, staged: true };
                    diffText = '';
                    render();
                    void showDiff().catch(e => notice(String(e), true));
                }
                else
                    void call<{
                        path: string;
                    }>('file-path', { repo: selected, file: file.path }).then(data => { if (!extensions.files)
                        throw new Error(t('Открытие файлов недоступно в этом режиме Codex')); return extensions.files.open(data.path); }).catch(e => notice(String(e), true));
            });
            row.append(name, count, open);
            if (!staged)
                row.append(iconButton(icons.discard, 'Discard Changes', () => { discardFile = file.path; el('discardFile').textContent = file.path; el<HTMLDialogElement>('discardDialog').showModal(); }));
            row.append(change);
            list.append(row);
        }
    }
    if (!repo?.files.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = repo ? t('Нет изменений') : t('Подключите папку с Git-репозиториями');
        list.append(empty);
    }
    list.scrollTop = scroll;
    controls();
}
async function showDiff() {
    const repo = selected, file = selection.file, staged = selection.staged, full = fullFile;
    if (!file || !current()?.files.some(f => f.path === file)) {
        el('diff').replaceChildren();
        el('diffRuler').replaceChildren();
        el('filename').textContent = t('Выберите файл');
        return;
    }
    const data = await call<{
        diff: string;
    }>('diff', { repo, file, staged, full });
    if (full !== fullFile || repo !== selected || file !== selection.file || staged !== selection.staged)
        return;
    if (data.diff === diffText)
        return;
    diffText = data.diff;
    const view = el('diff'), scroll = view.scrollTop, left = view.scrollLeft;
    el('filename').textContent = t(`${file} · ${staged ? t('Подготовлено к коммиту') : t('Изменения в файле')}`);
    view.replaceChildren();
    for (const line of (data.diff || t('Нет текстовых изменений')).split('\n')) {
        const span = document.createElement('span');
        span.className = 'line ' + (line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : '');
        span.textContent = line || ' ';
        view.append(span);
    }
    view.scrollTop = scroll;
    view.scrollLeft = left;
    updateRuler();
}
async function refresh() { if (refreshing)
    return; refreshing = true; try {
    snapshot = await call<Snapshot>('refresh');
    setUiLanguage(snapshot.config.uiLanguage);
    for (const [id, draft] of Object.entries(snapshot.config.drafts))
        if (!drafts.has(id))
            drafts.set(id, draft);
    for (const [id, hash] of Object.entries(snapshot.config.generatedHashes || {}))
        if (!generated.has(id))
            generated.set(id, hash);
    const old = selected;
    render();
    if (old !== selected)
        message.value = drafts.get(selected) || '';
    await loadRemoteInfo();
    await showDiff();
}
catch (error) {
    notice(String(error), true);
}
finally {
    refreshing = false;
} }
async function saveDraft(repo = selected, text = message.value) { if (repo) {
    drafts.set(repo, text);
    await call('draft', { repo, message: text, hash: generated.get(repo) });
} }
message.oninput = () => { controls(); drafts.set(selected, message.value); clearTimeout(draftTimer); const repo = selected, text = message.value; draftTimer = setTimeout(() => { void saveDraft(repo, text).catch(e => notice(String(e), true)); }, 300); };
for (const [id, full] of [['changesOnly', false], ['fullFile', true]] as const)
    el(id).onclick = () => { fullFile = full; diffText = ''; el('changesOnly').setAttribute('aria-pressed', String(!full)); el('fullFile').setAttribute('aria-pressed', String(full)); void showDiff().catch(e => notice(String(e), true)); };
document.addEventListener('pointerdown', event => { for (const id of ['repoPicker', 'commitMenu']) {
    const menu = el<HTMLDetailsElement>(id);
    if (event.target instanceof Node && !menu.contains(event.target))
        menu.open = false;
} });
document.addEventListener('keydown', event => { if (event.key === 'Escape')
    for (const id of ['repoPicker', 'commitMenu'])
        el<HTMLDetailsElement>(id).open = false; });
el('refresh').onclick = () => void refresh();
el('root').onclick = () => void action(async () => { snapshot = await call<Snapshot>('choose_root'); selected = ''; render(); message.value = drafts.get(selected) || ''; notice(t('Папка подключена')); });
el('connectRemote').onclick = () => { el<HTMLInputElement>('remoteUrl').value = ''; el<HTMLDialogElement>('remoteDialog').showModal(); };
el('remoteCancel').onclick = () => el<HTMLDialogElement>('remoteDialog').close();
el('remoteConfirm').onclick = () => { const url = el<HTMLInputElement>('remoteUrl').value.trim(); if (!url) {
    notice(t('Введите GitHub URL'), true);
    return;
} const id = selected; void action(async () => { await call('add_origin', { repo: id, url }); el<HTMLDialogElement>('remoteDialog').close(); remoteInfo = undefined; notice(t('GitHub remote origin подключён. Нажмите Push, чтобы отправить коммиты.')); }); };
el('stageAll').innerHTML = icons.plus;
el('stageAll').title = 'Stage All Changes';
el('stageAll').setAttribute('aria-label', 'Stage All Changes');
el('stageAll').onclick = () => void action(async () => { await call('stage', { repo: selected }); notice(t('Все изменения подготовлены')); });
el('generate').onclick = () => void action(async () => {
    if (!current()?.files.length) {
        notice(t('Нет изменений для генерации сообщения'));
        return;
    }
    generationRepo = selected;
    const job = await call<{
        id: string;
        hash: string;
    }>('generate', { repo: selected });
    jobId = job.id;
    notice(t('Генерация сообщения по staged diff…'));
    controls();
});
el('cancel').onclick = () => { void call('cancel', { job: jobId }).then(() => { jobId = ''; controls(); notice(t('Генерация отменена')); }, e => notice(String(e), true)); };
async function pollJob() { if (!jobId)
    return; const id = jobId; try {
    const job = await call<{
        state: string;
        message?: string;
        error?: string;
        hash: string;
    }>('job', { job: id });
    if (id !== jobId || job.state === 'running')
        return;
    jobId = '';
    if (job.state === 'done' && job.message) {
        drafts.set(generationRepo, job.message);
        generated.set(generationRepo, job.hash);
        if (selected === generationRepo)
            message.value = job.message;
        await saveDraft(generationRepo, job.message);
        notice(t('Сообщение готово. Проверьте его перед коммитом.'));
    }
    else
        notice(job.error || t('Генерация отменена'), job.state === 'error');
    controls();
}
catch (error) {
    notice(String(error), true);
} }
let pushResolve: ((value: {
    remote: string;
    branch: string;
} | null) => void) | undefined;
async function confirmPush(id: string) {
    const direction = await call<Direction>('direction', { repo: id });
    if (!direction.remotes.length)
        throw new Error(t('Remote отсутствует. Добавьте remote в репозиторий.'));
    const remote = el<HTMLSelectElement>('remote');
    remote.replaceChildren();
    for (const name of direction.remotes) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        remote.append(option);
    }
    remote.value = direction.remote || direction.remotes[0];
    remote.disabled = !!direction.remote;
    const branch = el<HTMLInputElement>('targetBranch');
    branch.value = direction.ref.replace(/^refs\/heads\//, '') || direction.branch;
    branch.disabled = !!direction.remote;
    el('pushFrom').textContent = t(`${snapshot?.repos.find(r => r.id === id)?.name}: ${direction.branch} → remote / ветка ниже`);
    el('pushUrl').textContent = direction.url;
    const dialog = el<HTMLDialogElement>('pushDialog');
    dialog.showModal();
    const chosen = await new Promise<{
        remote: string;
        branch: string;
    } | null>(resolve => { pushResolve = resolve; });
    return chosen ? { ...chosen, expectedBranch: direction.branch } : null;
}
function closePush(confirm: boolean) { const value = confirm ? { remote: el<HTMLSelectElement>('remote').value, branch: el<HTMLInputElement>('targetBranch').value } : null; el<HTMLDialogElement>('pushDialog').close(); pushResolve?.(value); pushResolve = undefined; }
el('pushClose').onclick = () => closePush(false);
el('pushConfirm').onclick = () => closePush(true);
el<HTMLDialogElement>('pushDialog').oncancel = () => closePush(false);
async function commit(withPush: boolean) { const id = selected; if (!message.value.trim())
    throw new Error(t('Введите сообщение коммита')); const target = withPush ? await confirmPush(id) : null; if (withPush && !target)
    return; await saveDraft(); await call('commit', { repo: id, message: message.value, hash: current()?.changesHash || current()?.stagedHash }); message.value = ''; await saveDraft(id, ''); generated.delete(id); pendingPush.add(id); notice(t('Коммит создан')); if (target) {
    try {
        await call('push', { repo: id, ...target });
        pendingPush.delete(id);
        notice(t('Коммит создан и отправлен'));
    }
    catch (error) {
        notice(t(`Коммит создан, push не выполнен\n${String(error)}\nДля повтора нажмите Push.`), true);
    }
} }
el('commit').onclick = () => { if (mainIsPush())
    el('push').click();
else
    void action(() => commit(false), 'commit'); };
el('commitPush').onclick = () => void action(() => commit(true), 'commit');
el('push').onclick = () => void action(async () => { const id = selected; const target = await confirmPush(id); if (target) {
    await call('push', { repo: id, ...target });
    pendingPush.delete(id);
    notice(t('Push выполнен'));
} }, 'push');
type SettingOption = {
    value: string;
    label: string;
};
function setupSetting(id: string, value: string, options: SettingOption[]) {
    const details = el<HTMLDetailsElement>(id + 'Select'), input = el<HTMLInputElement>(id), list = details.querySelector<HTMLElement>('.settings-options')!, selected = details.querySelector<HTMLElement>('.selected-value')!;
    input.value = value;
    list.replaceChildren();
    const custom = id === 'model' ? el<HTMLInputElement>('customModel') : undefined;
    const choose = (next: string, label: string, manual = false) => { input.value = next; selected.textContent = label; details.open = false; if (custom) {
        custom.hidden = !manual;
        if (manual) {
            custom.value = next;
            custom.focus();
        }
    } for (const button of Array.from(list.querySelectorAll<HTMLButtonElement>('button')))
        button.setAttribute('aria-pressed', String(button.dataset.value === next && !manual)); };
    for (const option of options) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.value = option.value;
        button.textContent = option.label;
        button.onclick = () => choose(option.value, option.label);
        list.append(button);
    }
    const match = options.find(option => option.value === value);
    if (custom) {
        const other = document.createElement('button');
        other.type = 'button';
        other.textContent = t('Другая модель…');
        other.onclick = () => choose(match ? '' : input.value, t('Другая модель'), true);
        list.append(other);
        custom.oninput = () => { input.value = custom.value.trim(); };
    }
    choose(value, match?.label || (custom ? t('Другая модель') : value), !!custom && !match);
}
el('settings').onclick = () => {
    const model = snapshot?.config.model || 'gpt-6-luna';
    const models = snapshot?.models || [];
    const options = models.map(item => ({ value: item.id, label: item.name === item.id ? item.id : `${item.name} · ${item.id}` }));
    if (!options.some(item => item.value === 'gpt-6-luna'))
        options.push({ value: 'gpt-6-luna', label: 'GPT-6 Luna · gpt-6-luna' });
    setupSetting('model', model, options);
    setupSetting('uiLanguage', snapshot?.config.uiLanguage || 'en', [{ value: 'en', label: 'English' }, { value: 'ru', label: 'Русский' }]);
    setupSetting('language', snapshot?.config.language || 'English', [{ value: 'English', label: 'English' }, { value: 'Русский', label: 'Русский' }]);
    setupSetting('format', snapshot?.config.format || 'Conventional Commit', [{ value: 'Conventional Commit', label: t('Коммит с типом изменения') }, { value: 'Short descriptive subject', label: t('Краткое описание') }]);
    el<HTMLDialogElement>('settingsDialog').showModal();
};
el('saveSettings').onclick = () => void action(async () => { const model = el<HTMLInputElement>('model').value.trim(); if (!model)
    throw new Error(t('Выберите модель или введите её название')); await call('settings', { uiLanguage: el<HTMLInputElement>('uiLanguage').value, language: el<HTMLInputElement>('language').value, format: el<HTMLInputElement>('format').value, model }); el<HTMLDialogElement>('settingsDialog').close(); notice(t('Настройки сохранены')); });
for (const id of ['modelSelect', 'uiLanguageSelect', 'languageSelect', 'formatSelect'])
    el<HTMLDetailsElement>(id).addEventListener('toggle', () => { if (el<HTMLDetailsElement>(id).open)
        for (const other of ['modelSelect', 'uiLanguageSelect', 'languageSelect', 'formatSelect'])
            if (other !== id)
                el<HTMLDetailsElement>(other).open = false; });
document.addEventListener('pointerdown', event => { for (const id of ['modelSelect', 'uiLanguageSelect', 'languageSelect', 'formatSelect']) {
    const item = el<HTMLDetailsElement>(id);
    if (event.target instanceof Node && !item.contains(event.target))
        item.open = false;
} });
function theme(context: ReturnType<App['getHostContext']>) { if (context?.theme) {
    applyDocumentTheme(context.theme);
    document.documentElement.dataset.theme = context.theme;
} if (context?.styles?.variables)
    applyHostStyleVariables(context.styles.variables); }
app.addEventListener('hostcontextchanged', () => theme(app.getHostContext()));
app.ontoolresult = result => { const data = result.structuredContent as Snapshot | undefined; if (data?.repos) {
    snapshot = data;
    setUiLanguage(data.config.uiLanguage);
    for (const [id, draft] of Object.entries(data.config.drafts))
        if (!drafts.has(id))
            drafts.set(id, draft);
    for (const [id, hash] of Object.entries(data.config.generatedHashes || {}))
        generated.set(id, hash);
    render();
    message.value = drafts.get(selected) || '';
    notice(t('Готово'));
    void loadRemoteInfo();
} };
initI18n();
setUiLanguage();
await app.connect();
theme(app.getHostContext());
await refresh();
message.value = drafts.get(selected) || '';
if (el('notice').textContent === t('Подключение…'))
    notice(t('Готово'));
setInterval(() => { if (!busy && !document.hidden)
    void refresh(); }, 2000);
setInterval(() => void pollJob(), 250);
let discardFile = '';
el('discardCancel').onclick = () => el<HTMLDialogElement>('discardDialog').close();
el('discardConfirm').onclick = () => void action(async () => { await call('discard', { repo: selected, file: discardFile }); el<HTMLDialogElement>('discardDialog').close(); notice(t('Изменения файла сохранены в stash и отменены')); });
for (const dialog of Array.from(document.querySelectorAll('dialog'))) {
    const close = document.createElement('button');
    close.className = 'dialog-close';
    close.textContent = '×';
    close.setAttribute('aria-label', t('Закрыть'));
    close.onclick = () => { if (dialog.id === 'pushDialog')
        closePush(false);
    else
        dialog.close(); };
    dialog.prepend(close);
}
function updateRuler() {
    const view = el('diff'), ruler = el('diffRuler');
    ruler.replaceChildren();
    const lines = Array.from(view.querySelectorAll<HTMLElement>('.line'));
    for (const [i, line] of lines.entries())
        if (line.classList.contains('add') || line.classList.contains('del')) {
            const mark = document.createElement('button');
            mark.className = 'ruler-mark ' + (line.classList.contains('add') ? 'plus' : 'minus');
            mark.style.top = `${i / Math.max(1, lines.length) * 100}%`;
            mark.title = t(`Перейти к строке ${i + 1}`);
            mark.onclick = () => { view.scrollTop = line.offsetTop - view.offsetTop; };
            ruler.append(mark);
        }
    const viewport = document.createElement('span');
    viewport.className = 'ruler-viewport';
    viewport.style.top = `${view.scrollTop / Math.max(1, view.scrollHeight) * 100}%`;
    viewport.style.height = `${Math.min(100, view.clientHeight / Math.max(1, view.scrollHeight) * 100)}%`;
    ruler.append(viewport);
}
el('diff').onscroll = updateRuler;
new ResizeObserver(updateRuler).observe(el('diff'));
