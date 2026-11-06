import type { History, HistoryCommit } from './git.js';
import { t } from './i18n.js';

const colors: Record<string, string> = {
    '31': '#eb719d', '32': '#94b65a', '33': '#e99c34',
    '34': '#539cff', '35': '#bd86e4', '36': '#42b9a9',
};
const allBranches = '@{all}';

type GraphCell = { mark: string; color: string };
const svgNamespace = 'http://www.w3.org/2000/svg';
const columnStep = 7;

function graphCells(line: string): GraphCell[] {
    let color = '';
    return line.split(/\x1b\[([0-9;]*)m/).flatMap((part, index) => {
        if (index % 2) {
            color = colors[part] || '';
            return [];
        }
        return Array.from(part, mark => ({ mark, color }));
    });
}

function graphEnds(cells: GraphCell[], side: 'top' | 'bottom') {
    const ends = new Map<number, string>();
    cells.forEach(({ mark, color }, index) => {
        if (mark === '|' || mark === '*') ends.set(index, color);
        else if (mark === '/') ends.set(index + (side === 'top' ? 1 : -1), color);
        else if (mark === '\\') ends.set(index + (side === 'top' ? -1 : 1), color);
        else if (mark === '.' && side === 'bottom') ends.set(index + 1, color);
    });
    return ends;
}

function graphLine(cells: GraphCell[], previous: GraphCell[], next: GraphCell[], width: number, connector: boolean) {
    const graph = document.createElementNS(svgNamespace, 'svg');
    const height = connector ? 16 : 44;
    const middle = height / 2;
    graph.setAttribute('width', String(width));
    graph.setAttribute('height', String(height));
    graph.setAttribute('viewBox', `0 0 ${width} ${height}`);
    graph.classList.add('history-graph');
    graph.setAttribute('aria-hidden', 'true');
    const before = graphEnds(previous, 'bottom');
    const after = graphEnds(next, 'top');
    const path = (d: string, color: string) => {
        const edge = document.createElementNS(svgNamespace, 'path');
        edge.setAttribute('d', d);
        edge.setAttribute('stroke', color || 'var(--accent)');
        edge.setAttribute('fill', 'none');
        edge.setAttribute('stroke-width', '1.5');
        graph.append(edge);
    };
    cells.forEach(({ mark, color }, index) => {
        const x = 12 + index * columnStep;
        const left = x - columnStep, right = x + columnStep;
        if (mark === '|') path(`M${x} 0 V${height}`, color);
        if (mark === '/' || mark === '\\') {
            const direction = mark === '/' ? -1 : 1;
            // Git advances consecutive diagonal glyphs by one column per row.
            const from = x - direction * columnStep * (previous[index - direction]?.mark === mark ? 0.5 : 1);
            const to = x + direction * columnStep * (next[index + direction]?.mark === mark ? 0.5 : 1);
            const d = `M${from} 0 C${from} ${middle}, ${to} ${middle}, ${to} ${height}`;
            path(d, color);
        }
        if (mark === '-' || mark === '_') {
            const y = mark === '-' ? middle : height;
            path(`M${left} ${y} H${right}`, color);
        }
        if (mark === '.') path(`M${left} ${middle} Q${right} ${middle}, ${right} ${height}`, color);
        if (mark === '*') {
            const nodeColor = color || after.get(index) || before.get(index) || 'var(--accent)';
            if (before.has(index)) path(`M${x} 0 V${middle}`, before.get(index) || nodeColor);
            if (after.has(index)) path(`M${x} ${middle} V${height}`, after.get(index) || nodeColor);
            for (const radius of [5, 1.8]) {
                const circle = document.createElementNS(svgNamespace, 'circle');
                circle.setAttribute('cx', String(x));
                circle.setAttribute('cy', String(middle));
                circle.setAttribute('r', String(radius));
                circle.setAttribute('fill', radius === 5 ? 'var(--panel)' : nodeColor);
                circle.setAttribute('stroke', nodeColor);
                circle.setAttribute('stroke-width', '1.4');
                graph.append(circle);
            }
        }
    });
    return graph;
}

function renderGraph(data: History, list: HTMLOListElement, all: boolean, select: (commit: HistoryCommit) => void) {
    const rows = document.createDocumentFragment();
    const timestampFormat = new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
        dateStyle: 'short',
        timeStyle: 'short',
    });
    const lines = data.commits.flatMap(commit => commit.graph.map((line, index) => ({
        cells: graphCells(line.trimEnd()),
        commit: index === commit.graph.length - 1 ? commit : undefined,
    })));
    for (const [index, { cells, commit }] of lines.entries()) {
        const row = document.createElement('li');
        const width = 24 + Math.max(0, cells.length - 1) * columnStep;
        row.append(graphLine(cells, lines[index - 1]?.cells || [], lines[index + 1]?.cells || [], width, !commit));
        if (!commit) {
            row.className = 'history-connector';
            row.setAttribute('aria-hidden', 'true');
            rows.append(row);
            continue;
        }
        const details = document.createElement('button');
        details.type = 'button';
        details.onclick = () => select(commit);
        details.className = 'history-details';
        const heading = document.createElement('span');
        heading.className = 'history-commit-heading';
        const metadata = document.createElement('span');
        metadata.className = 'history-commit-meta';
        const subject = document.createElement('span');
        subject.className = 'history-subject';
        subject.textContent = commit.subject || commit.hash.slice(0, 8);
        row.title = [commit.subject, commit.hash, commit.author, commit.date].join('\n');
        heading.append(subject);
        for (const ref of data.refs.filter(ref => ref.hash === commit.hash)) {
            const badge = document.createElement('span');
            badge.className = ref.remote ? 'history-ref remote' : 'history-ref';
            if (!ref.remote && ref.name === (all ? data.currentBranch : data.branch)) badge.classList.add('active');
            badge.textContent = ref.name;
            badge.title = ref.name;
            heading.append(badge);
        }
        const hash = document.createElement('code');
        hash.textContent = commit.hash.slice(0, 8);
        metadata.append(hash);
        const date = new Date(commit.date);
        if (Number.isFinite(date.getTime())) {
            const timestamp = document.createElement('time');
            timestamp.dateTime = commit.date;
            timestamp.textContent = timestampFormat.format(date);
            metadata.append(timestamp);
        }
        details.append(heading, metadata);
        row.append(details);
        rows.append(row);
    }
    list.replaceChildren(rows);
}

export function mountHistory(
    load: (repo: string, branch: string | undefined, limit: number, all: boolean) => Promise<History>,
    loadFiles: (repo: string, hash: string) => Promise<{ files: string[] }>,
    loadDiff: (repo: string, hash: string, file: string) => Promise<{ diff: string }>,
    renderDiff: (view: HTMLElement, diff: string) => void,
) {
    const changes = document.querySelector<HTMLButtonElement>('#changesTab')!;
    const tab = document.querySelector<HTMLButtonElement>('#historyTab')!;
    const branchSelect = document.querySelector<HTMLSelectElement>('#historyBranch')!;
    const list = document.querySelector<HTMLOListElement>('#historyCommits')!;
    const status = document.getElementById('historyStatus')!;
    const reload = document.querySelector<HTMLButtonElement>('#historyReload')!;
    const more = document.querySelector<HTMLButtonElement>('#historyMore')!;
    const history = document.getElementById('historyView')!;
    let repo = '', current = '', branch: string | undefined;
    let limit = 100, request = 0;
    const overview = document.getElementById('historyOverview')!;
    const detail = document.getElementById('historyDetail')!;
    const back = document.getElementById('historyBack')!;
    const picker = document.getElementById('historyFilePicker')!;
    const file = document.querySelector<HTMLSelectElement>('#historyFile')!;
    const detailStatus = document.getElementById('historyDetailStatus')!;
    const diff = document.getElementById('historyDiff')!;
    let detailRequest = 0, hash = '', trigger: HTMLElement | null = null;
    function closeDetail() {
        detailRequest++;
        hash = '';
        detail.hidden = true;
        overview.hidden = false;
        trigger = null;
    }
    back.onclick = () => {
        const previous = trigger;
        closeDetail();
        if (previous?.isConnected) previous.focus();
        else branchSelect.focus();
    };
    function setStatus(text: string) {
        detailStatus.textContent = t(text);
        detailStatus.hidden = !text;
    }
    async function showDiff() {
        if (!hash || !file.value) return;
        const id = ++detailRequest;
        diff.hidden = true;
        setStatus('Загрузка diff…');
        try {
            const result = await loadDiff(repo, hash, file.value);
            if (id !== detailRequest) return;
            renderDiff(diff, result.diff);
            diff.scrollTop = diff.scrollLeft = 0;
            diff.hidden = false;
            setStatus('');
        } catch (error) {
            if (id === detailRequest) setStatus(String(error));
        }
    }
    file.onchange = () => void showDiff();
    async function selectCommit(commit: HistoryCommit) {
        const id = ++detailRequest;
        trigger = document.activeElement as HTMLElement | null;
        hash = commit.hash;
        document.getElementById('historyCommitTitle')!.textContent = commit.subject;
        document.getElementById('historyCommitHash')!.textContent = hash.slice(0, 8);
        document.getElementById('historyCommitHash')!.title = hash;
        picker.hidden = diff.hidden = true;
        overview.hidden = true;
        detail.hidden = false;
        back.focus();
        setStatus('Загрузка файлов коммита…');
        try {
            const { files } = await loadFiles(repo, hash);
            if (id !== detailRequest) return;
            if (!files.length) {
                setStatus('В коммите нет изменений');
                return;
            }
            file.replaceChildren(...files.map(path => new Option(path, path)));
            picker.hidden = false;
            await showDiff();
        } catch (error) {
            if (id === detailRequest) setStatus(String(error));
        }
    }

    async function refresh(clear = false) {
        const id = ++request;
        if (clear) {
            list.replaceChildren();
            more.hidden = true;
        }
        branchSelect.disabled = true;
        reload.disabled = true;
        more.disabled = true;
        status.textContent = t(repo ? 'Загрузка истории…' : 'Выберите репозиторий для просмотра истории');
        if (!repo) {
            branchSelect.replaceChildren();
            return;
        }
        try {
            const all = branch === allBranches;
            const data = await load(repo, all ? undefined : branch, limit, all);
            if (id !== request) return;
            const branches = data.currentBranch ? data.branches : ['', ...data.branches];
            branchSelect.replaceChildren(...branches.map(name => {
                const label = name || 'HEAD';
                return new Option(name === data.currentBranch ? `${label} · ${t('Текущая ветка')}` : label, name);
            }));
            branchSelect.add(new Option(t('Все ветки'), allBranches));
            branchSelect.value = all ? allBranches : data.branch;
            renderGraph(data, list, all, commit => void selectCommit(commit));
            more.hidden = !data.more || limit >= 2000;
            status.textContent = !data.commits.length ? t(all ? 'Нет коммитов' : 'В этой ветке пока нет коммитов') :
                data.more && limit >= 2000 ? t('Показаны последние 2000 коммитов') : '';
        } catch (error) {
            if (id === request) status.textContent = String(error);
        } finally {
            if (id === request) {
                branchSelect.disabled = !branchSelect.options.length;
                reload.disabled = false;
                more.disabled = false;
            }
        }
    }
    function show(open: boolean) {
        history.hidden = !open;
        document.getElementById('changesSplit')!.hidden = open;
        document.querySelector<HTMLElement>('.changes-heading')!.hidden = open;
        document.querySelector<HTMLElement>('.composer')!.hidden = open;
        closeDetail();
        tab.setAttribute('aria-pressed', String(open));
        changes.setAttribute('aria-pressed', String(!open));
        if (open) void refresh(true);
        else request++;
    }
    tab.onclick = () => { if (history.hidden) show(true); };
    const showChanges = () => { if (!history.hidden) show(false); };
    changes.onclick = showChanges;
    reload.onclick = () => void refresh();
    more.onclick = () => { limit = Math.min(2000, limit + 100); void refresh(); };
    branchSelect.onchange = () => {
        branch = branchSelect.value;
        limit = 100;
        void refresh(true);
    };
    return {
        showChanges,
        reload() {
            if (!history.hidden) void refresh();
        },
        sync(id: string, checkedOut: string) {
            if (repo === id && current === checkedOut) return;
            repo = id;
            current = checkedOut;
            branch = undefined;
            limit = 100;
            closeDetail();
            if (!history.hidden) void refresh(true);
        },
    };
}
