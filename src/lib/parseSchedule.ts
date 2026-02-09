import type { Day } from './parseAladin';

const DEBUG = new URLSearchParams(globalThis.location?.search ?? '').has('debug');

function dlog(...args: unknown[]) {
    if (DEBUG) console.log('[schedule]', ...args);
}
function dgroup(title: string) {
    if (DEBUG) console.groupCollapsed('[schedule]', title);
}
function dgroupEnd() {
    if (DEBUG) console.groupEnd();
}

const DAYS: Day[] = ['Pon', 'Uto', 'Str', 'Stv', 'Pia'];
const DAY_LINE_RE = /^\s*(Pon|Uto|Str|Stv|Štv|Pia)\b/;
const ROOM_RE = /\b[a-z]{1,2}\d{2,3}[a-z]?\b/gi;
const TITLE_RE = /[@#]?[A-Za-z0-9]{3,}[-A-Za-z0-9]*/g;

export type Slot = {
    day: Day;
    startMin: number;
    endMin: number;
    title: string;
    room?: string;
    sourceUrl: string;
};


export function parseScheduleFromHtml(html: string, sourceUrl: string): Slot[] {
    const hasTable = /<table[\s>]/i.test(html);
    dgroup(`parseScheduleFromHtml: ${sourceUrl}`);
    dlog('hasTable=', hasTable);

    if (hasTable) {
        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const tables = Array.from(doc.querySelectorAll('table')) as HTMLTableElement[];
            dlog('tables found:', tables.length);

            const all: Slot[] = [];
            tables.forEach((t, idx) => {
                const part = parseScheduleFromTable(t, sourceUrl, idx);
                dlog(`table #${idx}: slots=`, part.length);
                if (part.length) all.push(...part);
            });
            dlog('all slots from tables:', all.length);
            dgroupEnd();
            if (all.length) return all;
        } catch (e) {
            dlog('DOMParser failed, fallback to <pre>. Error=', e);
        }
    }

    // Fallback len ak žiadna tabuľka nedala sloty (staršie ASCII stránky)
    const pre = extractPre(html);
    const slots = parseScheduleFromPre(pre, sourceUrl);
    dlog('slots from <pre>:', slots.length);
    dgroupEnd();
    return slots;
}

function parseScheduleFromTable(table: HTMLTableElement, sourceUrl: string, idx: number): Slot[] {
    const rows = Array.from(table.querySelectorAll('tr'));
    dgroup(`table #${idx}: rows=${rows.length}`);
    if (!rows.length) { dgroupEnd(); return []; }

    // nájdi prvý riadok, ktorého prvá bunka je názov dňa
    const firstDayIdx = rows.findIndex(tr => {
        const cell = (tr.children?.[0] as HTMLTableCellElement | undefined);
        const txt = normalizeText(cell?.textContent ?? '');
        return isDayLabel(txt);
    });
    dlog('firstDayIdx=', firstDayIdx);

    const headerRows = firstDayIdx > 0 ? rows.slice(0, firstDayIdx) : rows.slice(0, Math.min(2, rows.length));
    const boundaries = buildBoundariesFromHeaderRows(headerRows);
    dlog('boundaries (mins)=', boundaries);
    if (boundaries.length < 2) { dgroupEnd(); return []; }

    const slots: Slot[] = [];
    let currentDay: Day | null = null;

    const startAt = firstDayIdx >= 0 ? firstDayIdx : 1;
    for (let ri = startAt; ri < rows.length; ri++) {
        const tr = rows[ri] as HTMLTableRowElement;
        const cells = Array.from(tr.children) as HTMLTableCellElement[];
        if (!cells.length) continue;

        let ci = 0;
        const firstTxt = normalizeText(cells[0]?.textContent ?? '');
        if (isDayLabel(firstTxt)) {
            currentDay = (firstTxt.startsWith('Š') ? 'Stv' : (firstTxt as Day)) as Day;
            dlog(`row ${ri}: day=`, currentDay);
            if (!DAYS.includes(currentDay)) currentDay = null;
            ci = 1;
        }
        if (!currentDay) continue;

        let colCursor = 0;
        for (; ci < cells.length; ci++) {
            const td = cells[ci];
            const span = Number.parseInt(td.getAttribute('colspan') ?? '1', 10) || 1;

            const lines = getCellLines(td);
            if (lines.length) {
                const startMin = boundaries[colCursor] ?? boundaries[0];
                const endMin   = boundaries[Math.min(colCursor + span, boundaries.length - 1)];

                const raw = lines.join(' ');
                const title = (lines[0] || pickTitle(raw)) ?? null;

                let room: string | undefined;
                for (const ln of lines.slice(1)) {
                    const m = ln.match(ROOM_RE);
                    if (m) { room = m[0]; break; }
                }
                if (!room) {
                    const m = raw.match(ROOM_RE);
                    if (m) room = m[0];
                }

                dlog(`→ slot? ${startMin}–${endMin} ${title} ${room ?? ''}`);
                if (title && startMin < endMin) {
                    slots.push({ day: currentDay, startMin, endMin, title, room, sourceUrl });
                }
            }

            colCursor += span;
        }
    }

    dlog('slots from this table:', slots.length);
    dgroupEnd();
    return slots;
}

function buildBoundariesFromHeaderRows(headerRows: HTMLTableRowElement[]): number[] {
    // 1) Vyber riadok hlavičky, ktorý má najviac buniek s časom HH:MM
    let bestRow: HTMLTableRowElement | null = null;
    let bestCount = -1;

    for (const r of headerRows) {
        const cells = Array.from(r.children) as HTMLTableCellElement[];
        let c = 0;
        for (const cell of cells.slice(1)) { // ignoruj prvú "Hod/Zac"
            const html = cell.innerHTML;
            c += (html.match(/\b\d{1,2}\s*:\s*[0-5]\d\b/g) ?? []).length;
        }
        if (c > bestCount) { bestCount = c; bestRow = r; }
    }

    // Ak by sa nič nenašlo, padni na default 14 hodín 7:00–20:00
    if (!bestRow) {
        const anchors = Array.from({ length: 14 }, (_, i) => 7 * 60 + i * 60);
        return [...anchors, anchors[anchors.length - 1] + 60];
    }

    // 2) Koľko stĺpcov očakávame (so započítaním colspan)
    const bestCells = Array.from(bestRow.children) as HTMLTableCellElement[];
    const cols = bestCells.slice(1)
        .reduce((sum, cell) => sum + (parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1), 0) || 14;

    // 3) Z každej bunky (okrem prvej) vyber posledný HH:MM z jej HTML
    const anchors: number[] = [];
    for (const cell of bestCells.slice(1)) {
        const html = cell.innerHTML; // tu je bezpečné, nechávame <br> apod.
        let last: RegExpExecArray | null = null;
        const re = /\b(\d{1,2})\s*:\s*([0-5]\d)\b/g;
        for (;;) {
            const m = re.exec(html);
            if (!m) break;
            last = m;
        }
        if (last) {
            const h = Number(last[1]);
            const mm = Number(last[2]);
            anchors.push(h * 60 + mm);
        }
    }

    // 4) Stabilizácia: ak je málo časov, dopočítaj po 60 min; ak je ich viac, orež
    if (anchors.length < 2) {
        const start = 7 * 60;
        const a = Array.from({ length: cols }, (_, i) => start + i * 60);
        return [...a, a[a.length - 1] + 60];
    }
    while (anchors.length < cols) anchors.push(anchors[anchors.length - 1] + 60);
    if (anchors.length > cols) anchors.length = cols;

    // 5) Hranice = začiatky + posledný + 60
    return [...anchors, anchors[anchors.length - 1] + 60];
}

function getCellLines(td: HTMLTableCellElement): string[] {
    const rawHtml = td.innerHTML;
    dlog('cell html (first80)=', rawHtml.slice(0, 80).replace(/\n/g, '\\n'));
    const html = rawHtml.replace(/<br\s*\/?>/gi, '\n');
    const ta = document.createElement('textarea');
    ta.innerHTML = html;
    const text = ta.value.replace(/\u00A0/g, ' ');
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    return lines;
}

function normalizeText(s: string): string {
    return s.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
}

function isDayLabel(s: string): boolean {
    return /^(Pon|Uto|Str|Stv|Štv|Pia)$/i.test(s);
}

function extractPre(html: string): string {
    const match = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)?.[1] ?? html;
    const ta = document.createElement('textarea');
    ta.innerHTML = match;
    const decoded = ta.value;
    return decoded.replace(/\r/g, '').replace(/\u00A0/g, ' ');
}

function parseScheduleFromPre(pre: string, sourceUrl: string): Slot[] {
    const lines = pre.split('\n');
    if (lines.length < 5) return [];

    // NOVÉ: zbierame časové kotvy z viacerých riadkov
    const tm = buildTimeMapperFromManyLines(lines);
    const timeMap = tm.map;
    const gridStart = tm.startCol;

    // nájdi riadky so začiatkom dňa
    const dayIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (DAY_LINE_RE.test(lines[i])) dayIndices.push(i);
    }
    dayIndices.sort((a, b) => a - b);

    const slots: Slot[] = [];
    for (let di = 0; di < dayIndices.length; di++) {
        const start = dayIndices[di];
        const end = di + 1 < dayIndices.length ? dayIndices[di + 1] : lines.length;
        const dayLine = lines[start];
        const dayRaw = dayLine.match(/(Pon|Uto|Str|Stv|Štv|Pia)/)?.[1] ?? '';
        const day = (dayRaw.startsWith('Š') ? 'Stv' : (dayRaw as Day)) as Day;
        if (!DAYS.includes(day)) continue;

        const blockLines = padToSameLength(lines.slice(start, end));
        const segments = findSegments(blockLines, gridStart);

        for (const seg of segments) {
            const startMin = timeMap(seg.from);
            const endMin = timeMap(seg.to);
            if (!(startMin < endMin)) continue;

            const textInside = extractText(blockLines, seg.from, seg.to);
            const title = pickTitle(textInside);
            if (!title) continue;
            const room = pickRoom(textInside);

            slots.push({ day, startMin, endMin, title, room, sourceUrl });
        }
    }
    return slots;
}

/** NOVÉ: Časové kotvy vyrobíme zo všetkých riadkov (prvých ~80). */
function buildTimeMapperFromManyLines(lines: string[]): { map: (col: number) => number; startCol: number } {
    const matches: Array<{ col: number; min: number }> = [];
    const limit = Math.min(lines.length, 80);
    const TIME_RE = /\b(\d{1,2}):([0-5]\d)\b/g;

    for (let i = 0; i < limit; i++) {
        const line = lines[i];
        for (const m of line.matchAll(TIME_RE)) {
            const h = Number(m[1]), mm = Number(m[2]);
            const col = m.index ?? 0;
            matches.push({ col, min: h * 60 + mm });
        }
    }

    matches.sort((a, b) => a.col - b.col || a.min - b.min);

    // zhlukovanie podľa stĺpca (tolerance ≈ 2 znaky)
    const anchors: Array<{ col: number; min: number }> = [];
    for (const m of matches) {
        const last = anchors[anchors.length - 1];
        if (!last || Math.abs(m.col - last.col) > 2) {
            anchors.push({ col: m.col, min: m.min });
        } else {
            // spriemeruj stĺpec a vezmi najmenší čas (ľavý kotviaci bod)
            last.col = Math.round((last.col + m.col) / 2);
            last.min = Math.min(last.min, m.min);
        }
    }

    // fallback, ak by sa nič nenašlo (malo by byť zriedkavé)
    if (anchors.length < 2) {
        const headerWidth = Math.max(...lines.slice(0, limit).map(l => l.length), 60);
        anchors.splice(0, anchors.length,
            { col: 0, min: 7 * 60 },
            { col: headerWidth, min: 20 * 60 },
        );
    }

    anchors.sort((a, b) => a.col - b.col);

    const startCol = anchors[0].col;

    // lineárna interpolácia medzi susednými kotvami
    const map = (col: number) => {
        if (col <= anchors[0].col) return anchors[0].min;
        if (col >= anchors[anchors.length - 1].col) return anchors[anchors.length - 1].min;
        for (let i = 0; i < anchors.length - 1; i++) {
            const a = anchors[i], b = anchors[i + 1];
            if (col >= a.col && col <= b.col) {
                const t = (col - a.col) / Math.max(1, b.col - a.col);
                return Math.round(a.min + t * (b.min - a.min));
            }
        }
        return anchors[0].min;
    };

    return { map, startCol };
}

function padToSameLength(lines: string[]): string[] {
    const width = Math.max(...lines.map(l => l.length));
    return lines.map(l => l.padEnd(width, ' '));
}

type Segment = { from: number; to: number };
function findSegments(blockLines: string[], fromCol: number): Segment[] {
    if (blockLines.length === 0) return [];
    const width = blockLines[0].length;
    const active: number[] = new Array(width).fill(0);

    for (const line of blockLines) {
        for (let c = fromCol; c < width; c++) {
            const ch = line[c] ?? ' ';
            if (/[A-Za-z0-9]/.test(ch)) active[c]++;
        }
    }

    // miernejšie spájanie – vyplň max 1-2 stĺpce medzier
    for (let c = fromCol + 1; c < width - 1; c++) {
        if (!active[c] && active[c - 1] && active[c + 1]) active[c] = 1;
        if (!active[c] && active[c - 1] && active[c + 2]) active[c] = 1;
    }

    const segs: Segment[] = [];
    let inRun = false; let start = fromCol;
    for (let c = fromCol; c < width; c++) {
        if (!inRun && active[c]) { inRun = true; start = c; }
        if (inRun && (!active[c] || c === width - 1)) {
            const end = active[c] ? c + 1 : c;
            if (end - start >= 3) segs.push({ from: start, to: end });
            inRun = false;
        }
    }
    return segs;
}

function extractText(lines: string[], from: number, to: number): string {
    const parts: string[] = [];
    for (const l of lines) {
        const slice = l.slice(from, to).trimEnd();
        if (slice.trim()) parts.push(slice);
    }
    return parts.join('\n');
}

function pickTitle(blockText: string): string | null {
    const all = [...blockText.matchAll(TITLE_RE)].map(m => m[0]);
    const filtered = all.filter(t => !/^(Pon|Uto|Str|Stv|Štv|Pia|Hod|Zac)$/i.test(t));
    if (filtered.length === 0) return null;
    return filtered.sort((a, b) => b.length - a.length)[0];
}

function pickRoom(blockText: string): string | undefined {
    const m = blockText.match(ROOM_RE);
    return m ? m[0] : undefined;
}

export function formatHM(min: number): string {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}