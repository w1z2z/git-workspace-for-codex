import { t, initI18n, setUiLanguage } from './i18n.js';
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import '@openai/mcp-extensions/app/styles.css';
import './style.css';
import { mountHistory } from './history.js';
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
const app = new App({ name: 'Git Workspace', version: '1.7.11' });
const extensions = new OpenAIExtensions(app);
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const buttonIds = ['stageAll', 'commit', 'commitPush', 'push', 'generate'];
let snapshot: Snapshot | undefined, selected = '', busy = false, refreshing = false, selection = { file: '', staged: false }, diffText = '', jobId = '', generationRepo = '';
const drafts = new Map<string, string>(), generated = new Map<string, string>();
let fullFile = false, repoCardsSignature = '', displayedRepo = '', remoteInfo: Direction | undefined, remoteInfoRepo = '';
const pendingPush = new Set<string>();
let operation = '';
const mainIsPush = () => !!current() && !current()!.files.length && (pendingPush.has(selected) || current()!.outgoing > 0);
const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
const message = el<HTMLTextAreaElement>('message');
const notice = (text: string, error = false) => { el('notice').textContent = t(text); el('notice').className = error ? 'error' : ''; };
async function call<T extends object = Record<string, unknown>>(action: string, args: object = {}): Promise<T> { const response = await app.callServerTool({ name: 'git_workspace_action', arguments: { action, ...args } }); const data = response.structuredContent as ({
    ok: boolean;
    error?: string;
} & T) | undefined; if (!data?.ok)
    throw new Error(data?.error || t('Сервер не вернул результат')); return data; }
const changesSplit = el('changesSplit');
const changesDivider = el('changesDivider');
const narrowChanges = matchMedia('(max-width: 820px)');
const historyView = mountHistory(
    (repo, branch, historyLimit, historyAll) => call('history', { repo, branch, historyLimit, historyAll }),
    (repo, hash) => call('history-files', { repo, hash }),
    (repo, hash, file) => call('history-diff', { repo, hash, file }),
    renderDiff,
);
function resizeFiles(percent: number) {
    const width = Math.round(Math.min(62, Math.max(25, percent)));
    changesSplit.style.setProperty('--files-width', width + '%');
    changesDivider.setAttribute('aria-valuenow', String(width));
}
changesDivider.setAttribute('aria-valuemin', '25');
changesDivider.setAttribute('aria-valuemax', '62');
resizeFiles(36);
let dragOffset = 0;
changesDivider.onpointerdown = event => {
    if (event.button !== 0) return;
    event.preventDefault();
    changesDivider.blur();
    dragOffset = event.clientX - changesDivider.getBoundingClientRect().left;
    changesDivider.setPointerCapture(event.pointerId);
    changesDivider.classList.add('dragging');
};
changesDivider.onlostpointercapture = () => changesDivider.classList.remove('dragging');
changesDivider.onpointermove = event => {
    if (!changesDivider.hasPointerCapture(event.pointerId)) return;
    const { left, width } = changesSplit.getBoundingClientRect();
    if (width) resizeFiles((event.clientX - left - dragOffset) / width * 100);
};
changesDivider.onkeydown = event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    resizeFiles(Number(changesDivider.getAttribute('aria-valuenow')) + (event.key === 'ArrowLeft' ? -3 : 3));
};
el('backToFiles').onclick = () => {
    changesSplit.classList.remove('show-file-diff');
    el('files').querySelector<HTMLButtonElement>('.file.active .file-select')?.focus();
};
el('openSelectedFile').onclick = async () => {
    const { file } = selection;
    const repo = selected;
    try {
        if (!extensions.files) throw new Error(t('Открытие файлов недоступно в этом режиме Codex'));
        const { path } = await call<{ path: string }>('file-path', { repo, file });
        if (repo === selected && file === selection.file && !changesSplit.hidden) await extensions.files.open(path);
    } catch (error) {
        if (repo === selected && file === selection.file) notice(String(error), true);
    }
};
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
    el('push').hidden = !repo || mainIsPush();
    el<HTMLButtonElement>('commit').disabled = busy || invalid || (!mainIsPush() && !changes);
    el('commit').innerHTML = t(`<span>${mainIsPush() ? 'Push' : 'Commit'}</span>${operation ? t('<span class="spinner" aria-label="Выполняется"></span>') : ''}`);
    for (const button of Array.from(el('repoCards').querySelectorAll('button')))
        button.disabled = busy;
    el<HTMLButtonElement>('root').disabled = busy || !!jobId;
    message.disabled = busy;
    el('cancel').hidden = !jobId;
    el('operationLoader').hidden = true;
    el<HTMLButtonElement>('remoteConfirm').disabled = busy;
    renderRemote();
    const generating = jobId && generationRepo === selected;
    el('generate').innerHTML = generating ? '<span class="spinner" aria-hidden="true"></span>' : icons.sparkle;
    const generateLabel = document.createElement('span');
    generateLabel.textContent = t(generating ? 'Генерация…' : 'Сгенерировать сообщение');
    el('generate').append(generateLabel);
    el('generate').setAttribute('aria-label', t('Сгенерировать сообщение'));
    el('generate').title = t(`Сгенерировать сообщение · ${snapshot?.config.model || 'gpt-6-luna'}`);
    el('stale').textContent = generated.has(selected) && generated.get(selected) !== (repo?.changesHash || repo?.stagedHash) ? t('Изменения обновились — проверьте сообщение') : '';
}
async function action(task: () => Promise<void>, label = '') {
    if (busy)
        return;
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
        if (label === 'commit' || label === 'push') historyView.reload();
    }
}
const svg = (body: string) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const icons = {
    changes: svg('<rect x="8" y="3" width="12" height="14" rx="2"/><path d="M16 21H6a2 2 0 0 1-2-2V9"/>'),
    history: svg('<path d="M3.5 9a9 9 0 1 1 2.1 9.4M3.5 4.5V9H8M12 7v5l3 2"/>'),
    branch: svg('<path d="M6 8v8m3 3h3a6 6 0 0 0 6-6V8"/><circle cx="6" cy="5" r="3"/><circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/>'),
    disclosure: svg('<path d="m6 9 6 6 6-6"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'), minus: svg('<path d="M5 12h14"/>'),
    discard: svg('<path d="M4 10h10a6 6 0 1 1-5.5 8M4 10l5-5M4 10l5 5"/>'),
    sparkle: svg('<path d="M10 2.5c.8 4.1 2.4 5.7 6.5 6.5-4.1.8-5.7 2.4-6.5 6.5-.8-4.1-2.4-5.7-6.5-6.5 4.1-.8 5.7-2.4 6.5-6.5ZM18.5 12.5c.4 2.5 1.5 3.6 4 4-2.5.4-3.6 1.5-4 4-.4-2.5-1.5-3.6-4-4 2.5-.4 3.6-1.5 4-4ZM5 16v5m-2.5-2.5h5"/>'),
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
function setActiveRepository(id: string) {
    selected = id;
    message.value = drafts.get(id) || '';
    selection = { file: '', staged: false };
    changesSplit.classList.remove('show-file-diff');
    el('openSelectedFile').hidden = true;
    diffText = '';
    remoteInfo = undefined;
    notice('');
    el('diff').replaceChildren();
    el('diffRuler').replaceChildren();
    el('filename').textContent = t('Выберите файл');
    el('diffContext').hidden = true;
}
const topNavigation = matchMedia('(max-width: 660px)');
function revealRepository(card: HTMLButtonElement, smooth: boolean) {
    const strip = el('repoCards');
    const viewport = strip.getBoundingClientRect();
    const item = card.getBoundingClientRect();
    strip.scrollTo({
        ...(topNavigation.matches
            ? { left: strip.scrollLeft + (item.left + item.width / 2) - (viewport.left + viewport.width / 2) }
            : { top: strip.scrollTop + (item.top + item.height / 2) - (viewport.top + viewport.height / 2) }),
        behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant',
    });
}
topNavigation.addEventListener('change', () => {
    const active = el('repoCards').querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    if (active) revealRepository(active, false);
});
function selectRepository(id: string, card: HTMLButtonElement) {
    if (busy) return;
    if (id !== selected) {
        setActiveRepository(id);
        displayedRepo = id;
        render();
        void loadRemoteInfo();
    }
    revealRepository(card, true);
}
function renderRepositories(repos: Repo[], hasRoot: boolean) {
    const strip = el('repoCards');
    const signature = JSON.stringify([hasRoot, document.documentElement.lang, repos.map(repo => [
        repo.id, repo.name, repo.branch, repo.files.length, repo.error,
    ])]);
    if (signature !== repoCardsSignature) {
        repoCardsSignature = signature;
        const { scrollLeft, scrollTop } = strip;
        const focusedId = strip.contains(document.activeElement) ?
            (document.activeElement as HTMLElement).dataset.repoId : undefined;
        const buttons = repos.map(repo => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'repo-card';
            card.dataset.repoId = repo.id;
            card.title = [repo.name, repo.branch].filter(Boolean).join(' · ');
            const name = document.createElement('strong');
            name.textContent = repo.name;
            const branch = document.createElement('span');
            branch.className = 'repo-card-branch';
            branch.innerHTML = icons.branch;
            const branchName = document.createElement('span');
            branchName.textContent = repo.branch || t('Нет ветки');
            branch.append(branchName);
            const count = document.createElement('span');
            count.className = 'badge';
            count.textContent = repo.error ? '!' : String(repo.files.length);
            if (repo.error) count.title = repo.error;
            card.append(name, branch, count);
            card.onclick = () => selectRepository(repo.id, card);
            return card;
        });
        if (!buttons.length) {
            const create = document.createElement('button');
            create.type = 'button';
            create.className = 'repo-create';
            create.textContent = t(hasRoot ? 'Создать репозиторий в этой папке' : 'Выбрать папку…');
            create.onclick = () => {
                if (!hasRoot) {
                    el('root').click();
                    return;
                }
                void action(async () => {
                    snapshot = await call<Snapshot>('init_repository');
                    setActiveRepository(snapshot.repos[0]?.id || '');
                    notice(t('Git-репозиторий создан'));
                });
            };
            buttons.push(create);
        }
        strip.replaceChildren(...buttons);
        strip.scrollLeft = scrollLeft;
        strip.scrollTop = scrollTop;
        if (focusedId) buttons.find(card => card.dataset.repoId === focusedId)?.focus({ preventScroll: true });
    }
    const cards = Array.from(strip.querySelectorAll<HTMLButtonElement>('.repo-card'));
    for (const card of cards) card.setAttribute('aria-pressed', String(card.dataset.repoId === selected));
    if (displayedRepo !== selected) {
        displayedRepo = selected;
        const active = cards.find(card => card.dataset.repoId === selected);
        if (active) revealRepository(active, false);
    }
}
function openFileDiff(file: string, staged: boolean) {
    const repo = selected;
    historyView.showChanges();
    selection = { file, staged };
    changesSplit.classList.add('show-file-diff');
    diffText = '';
    el('diff').replaceChildren();
    el('diffRuler').replaceChildren();
    el('diffContext').hidden = true;
    render();
    if (narrowChanges.matches) el('backToFiles').focus({ preventScroll: true });
    else el('files').querySelector<HTMLButtonElement>('.file.active .file-select')?.focus({ preventScroll: true });
    void showDiff().catch(error => {
        if (selected === repo && selection.file === file && selection.staged === staged) notice(String(error), true);
    });
}
const collapsedGroups = new Map<string, Set<string>>();
function render() {
    if (!snapshot)
        return;
    const nextRepo = snapshot.repos.some(repo => repo.id === selected) ? selected : snapshot.repos[0]?.id || '';
    if (nextRepo !== selected) setActiveRepository(nextRepo);
    const repo = current();
    historyView.sync(repo?.id || '', repo?.branch || '');
    el('activeRepoName').textContent = repo?.name || t('Нет репозитория');
    el('activeRepoName').title = repo?.name || '';
    const branchChip = el('activeRepoBranch');
    branchChip.hidden = !repo?.branch;
    el('activeBranchName').textContent = repo?.branch || '';
    branchChip.title = repo?.branch || '';
    const navCount = el('navCount');
    navCount.hidden = !repo?.files.length;
    navCount.textContent = String(repo?.files.length ?? 0);
    const fileCount = repo?.files.length ?? 0;
    el('changesSummary').textContent = repo ? `${fileCount} · ${t('Файлы')}` : '';
    const config = snapshot.config;
    el('generationPreferences').textContent = [config.model, config.language, config.format].filter(Boolean).join(' · ');
    renderRepositories(snapshot.repos, !!snapshot.config.root);
    el('rootPath').textContent = snapshot.config.root;
    el('rootPath').title = snapshot.config.root;
    el('branch').textContent = repo ? t(`${repo.upstream || t('Upstream не настроен')}  ·  ↓ ${repo.incoming}  ↑ ${repo.outgoing}`) : '';
    el('branch').title = t('Сравнение с локальным состоянием upstream. Автоматический fetch не выполняется.');
    renderRemote();
    const prepared = repo?.files.filter(f => !f.conflict && ![' ', '?'].includes(f.index)).length || 0;
    el('generationScope').textContent = t(prepared ? 'Генерация по подготовленным изменениям' : 'Генерация по всем изменениям при пустом staging');
    el('commitHint').textContent = prepared ? t(`В коммит ${repo?.name}: ${prepared} файл(ов)`) : repo?.files.length ? t('Без staging в Commit войдут все Changes') : t('Нет изменений для коммита');
    const list = el('files');
    const scroll = list.scrollTop;
    const focusedGroup = list.contains(document.activeElement)
        ? (document.activeElement as HTMLElement).dataset.fileGroup : undefined;
    const stageAll = el('stageAll');
    const stageAllFocused = document.activeElement === stageAll;
    document.querySelector('.files-toolbar')!.append(stageAll);
    list.replaceChildren();
    if (repo?.error)
        notice(repo.error, true);
    const groups = [
        ['conflicts', t('Конфликты'), (file: Repo['files'][number]) => file.conflict, false],
        ['staged', 'Staged Changes', (file: Repo['files'][number]) => !file.conflict && ![' ', '?'].includes(file.index), true],
        ['changes', 'Changes', (file: Repo['files'][number]) => !file.conflict && (file.index === '?' || ![' ', '?'].includes(file.worktree)), false],
    ] as const;
    const repoId = selected;
    const collapsed = collapsedGroups.get(repoId) || new Set<string>();
    for (const [group, title, match, staged] of groups) {
        const files = repo?.files.filter(match) || [];
        if (!files.length) continue;
        const heading = document.createElement('h4');
        const body = document.createElement('div');
        body.id = `file-group-${group}`;
        body.hidden = collapsed.has(group);
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'file-group-toggle';
        toggle.dataset.fileGroup = group;
        toggle.setAttribute('aria-controls', body.id);
        toggle.setAttribute('aria-expanded', String(!body.hidden));
        toggle.title = staged ? t('Эти изменения войдут в следующий коммит') : group === 'conflicts' ? t('Сначала разрешите конфликты в редакторе') : t('Эти изменения пока не войдут в коммит');
        toggle.innerHTML = icons.disclosure;
        const label = document.createElement('span');
        label.textContent = title;
        const total = document.createElement('span');
        total.className = 'file-group-count';
        total.textContent = `· ${files.length}`;
        toggle.append(label, total);
        toggle.onclick = () => {
            body.hidden = !body.hidden;
            if (body.hidden) collapsed.add(group);
            else collapsed.delete(group);
            collapsedGroups.set(repoId, collapsed);
            toggle.setAttribute('aria-expanded', String(!body.hidden));
        };
        heading.append(toggle);
        if (staged) {
            const unstageAll = iconButton(icons.minus, t('Убрать все из staging'), () => void action(async () => {
                await call('unstage', { repo: selected });
                selection.staged = false;
                notice(t('Все файлы возвращены в Changes'));
            }));
            unstageAll.classList.add('file-group-action');
            heading.append(unstageAll);
        } else if (group === 'changes') {
            heading.append(stageAll);
        }
        list.append(heading, body);
        for (const file of files) {
            const row = document.createElement('div');
            row.className = 'file' + (selection.file === file.path && selection.staged === staged ? ' active' : '');
            const select = document.createElement('button');
            select.type = 'button';
            select.className = 'file-select';
            select.setAttribute('aria-pressed', String(row.classList.contains('active')));
            const name = document.createElement('span');
            name.className = 'name';
            select.title = t(`Показать diff: ${file.path}`);
            const basename = document.createElement('span');
            basename.textContent = file.path.split('/').pop() || file.path;
            const folder = document.createElement('small');
            folder.textContent = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : file.index === '?' ? t('Новый файл') : '';
            name.append(basename, folder);
            const status = document.createElement('span');
            const code = file.conflict ? '!' : staged ? file.index : file.worktree;
            status.className = 'file-status';
            status.dataset.status = code;
            status.textContent = code.trim() || 'M';
            status.setAttribute('aria-hidden', 'true');
            select.onclick = () => openFileDiff(file.path, staged);
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
            select.append(status, name, count);
            row.append(select);
            if (!staged)
                row.append(iconButton(icons.discard, 'Discard Changes', () => { discardFile = file.path; el('discardFile').textContent = file.path; el('discardContext').textContent = [repo?.name, repo?.branch].filter(Boolean).join(' · '); el<HTMLDialogElement>('discardDialog').showModal(); }));
            row.append(change);
            body.append(row);
        }
    }
    if (!repo?.files.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = repo ? t('Нет изменений') : t('Подключите папку с Git-репозиториями');
        list.append(empty);
    }
    list.scrollTop = scroll;
    if (focusedGroup) list.querySelector<HTMLButtonElement>(`[data-file-group="${focusedGroup}"]`)?.focus({ preventScroll: true });
    const stageAllLabel = t('Подготовить все');
    stageAll.title = stageAllLabel;
    stageAll.setAttribute('aria-label', stageAllLabel);
    controls();
    if (stageAllFocused) stageAll.focus({ preventScroll: true });
}
async function showDiff() {
    const repo = selected, file = selection.file, staged = selection.staged, full = fullFile;
    const entry = current()?.files.find(item => item.path === file);
    const context = el('diffContext');
    el('openSelectedFile').hidden = !entry || entry.worktree === 'D' || (entry.index === 'D' && entry.worktree === ' ');
    if (!file || !entry) {
        changesSplit.classList.remove('show-file-diff');
        context.hidden = true;
        el('diff').replaceChildren();
        el('diffRuler').replaceChildren();
        el('filename').textContent = t('Выберите файл');
        return;
    }
    el('filename').textContent = file + ' · ' + t(staged ? 'Подготовлено к коммиту' : 'Изменения в файле');
    el('filename').title = file;
    const data = await call<{
        diff: string;
    }>('diff', { repo, file, staged, full });
    if (full !== fullFile || repo !== selected || file !== selection.file || staged !== selection.staged)
        return;
    context.hidden = false;
    context.textContent = t(staged ? 'Индекс относительно последнего коммита' : 'Рабочая копия относительно индекса');
    if (data.diff && data.diff === diffText)
        return;
    diffText = data.diff;
    const view = el('diff'), scroll = view.scrollTop, left = view.scrollLeft;
    renderDiff(view, data.diff, entry.index === '?');
    view.scrollTop = scroll;
    view.scrollLeft = left;
    updateRuler();
}
function renderDiff(view: HTMLElement, diff: string, untracked = false) {
    view.replaceChildren();
    const rows = document.createDocumentFragment();
    const lines = (diff || t('Нет текстовых изменений')).split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    let oldLine = 0, newLine = 1, insideHunk = untracked && diff.startsWith('+');
    for (const line of lines) {
        const row = document.createElement('span');
        row.className = 'line';
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) {
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[2]);
            insideHunk = true;
            row.classList.add('hunk');
        } else if (insideHunk && /^[ +\-]/.test(line)) {
            const marker = line[0];
            if (marker !== '+') row.dataset.old = String(oldLine++);
            if (marker !== '-') row.dataset.new = String(newLine++);
            if (marker === '+') row.classList.add('add');
            if (marker === '-') row.classList.add('del');
            row.classList.add('diff-source');
        } else {
            if (line.startsWith('diff --git ') || line.startsWith('@@')) insideHunk = false;
            row.classList.add('diff-meta');
        }
        row.textContent = line || ' ';
        rows.append(row);
    }
    view.append(rows);
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
message.oninput = () => {
    const repo = selected, text = message.value;
    if (!repo) return;
    controls();
    drafts.set(repo, text);
    clearTimeout(draftTimers.get(repo));
    draftTimers.set(repo, setTimeout(() => {
        draftTimers.delete(repo);
        void saveDraft(repo, text).catch(error => {
            if (selected === repo) notice(String(error), true);
        });
    }, 300));
};
for (const [id, full] of [['changesOnly', false], ['fullFile', true]] as const)
    el(id).onclick = () => { fullFile = full; diffText = ''; el('changesOnly').setAttribute('aria-pressed', String(!full)); el('fullFile').setAttribute('aria-pressed', String(full)); void showDiff().catch(e => notice(String(e), true)); };
el('refresh').onclick = () => { void refresh(); historyView.reload(); };
el('root').onclick = () => void action(async () => { snapshot = await call<Snapshot>('choose_root'); setActiveRepository(''); render(); message.value = drafts.get(selected) || ''; notice(t('Папка подключена')); });
el('connectRemote').onclick = () => { el<HTMLInputElement>('remoteUrl').value = ''; el<HTMLDialogElement>('remoteDialog').showModal(); };
el('remoteCancel').onclick = () => el<HTMLDialogElement>('remoteDialog').close();
el('remoteConfirm').onclick = () => { const url = el<HTMLInputElement>('remoteUrl').value.trim(); if (!url) {
    notice(t('Введите GitHub URL'), true);
    return;
} const id = selected; void action(async () => { await call('add_origin', { repo: id, url }); el<HTMLDialogElement>('remoteDialog').close(); remoteInfo = undefined; notice(t('GitHub remote origin подключён. Нажмите Push, чтобы отправить коммиты.')); }); };
el('stageAll').innerHTML = icons.plus;
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
        if (selected === generationRepo) notice(t('Сообщение готово. Проверьте его перед коммитом.'));
    }
    else if (selected === generationRepo)
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
el('changesIcon').innerHTML = icons.changes;
el('historyIcon').innerHTML = icons.history;
el('activeBranchIcon').innerHTML = icons.branch;
el('codexTitleIcon').innerHTML = icons.sparkle;
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
    if (view.scrollHeight <= view.clientHeight) return;
    const viewport = document.createElement('span');
    viewport.className = 'ruler-viewport';
    viewport.style.top = `${view.scrollTop / Math.max(1, view.scrollHeight) * 100}%`;
    viewport.style.height = `${Math.min(100, view.clientHeight / Math.max(1, view.scrollHeight) * 100)}%`;
    ruler.append(viewport);
}
el('diff').onscroll = updateRuler;
new ResizeObserver(updateRuler).observe(el('diff'));
