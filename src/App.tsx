import { useEffect, useMemo, useState } from 'react';
import { fetchCatalog, type Catalog, prettyYearLabel } from './lib/catalog';
import { fetchHtmlThroughCors } from './lib/fetchHtml';
import { parseScheduleFromHtml, type Slot, formatHM } from './lib/parseSchedule';
import type { JSX } from 'react';

type Sel = { year?: string; program?: string };
type MergedRow = Slot & { groups: string[] };

type ElectiveLink = { code: string; url: string };

const ALADIN_BASE = 'https://rozvrhy.fei.stuba.sk/';

const slotKey = (s: Slot) =>
    `${s.day}|${s.startMin}|${s.endMin}|${s.title}|${s.room ?? ''}`;

const isElectiveTitle = (t: string) => {
    const x = t.trim();
    return x.startsWith('@') || x.startsWith('#');
};

export default function App() {
    const [catalog, setCatalog] = useState<Catalog | null>(null);
    const [sel, setSel] = useState<Sel>({});
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const [merging, setMerging] = useState(false);
    const [merged, setMerged] = useState<MergedRow[] | null>(null);

    // --- Hidden slots (persist) ---
    const [hiddenKeys, setHiddenKeys] = useState<string[]>(() => {
        try { return JSON.parse(localStorage.getItem('hiddenSlots') || '[]'); }
        catch { return []; }
    });
    useEffect(() => {
        try { localStorage.setItem('hiddenSlots', JSON.stringify(hiddenKeys)); }
        catch (e) { /* ignore */ }
    }, [hiddenKeys]);
    const hiddenSet = useMemo(() => new Set(hiddenKeys), [hiddenKeys]);
    function hideSlot(s: Slot) {
        const k = slotKey(s);
        setHiddenKeys(prev => prev.includes(k) ? prev : [...prev, k]);
        if (isElectiveTitle(s.title)) {
            setElectiveKeys(prev => prev.filter(x => x !== k));
        }
    }
    function resetHidden() { setHiddenKeys([]); }

    // --- Checkboxy pre '@' voliteľky zo ZLUČENÉHO rozvrhu (persist) ---
    const [electiveKeys, setElectiveKeys] = useState<string[]>(() => {
        try { return JSON.parse(localStorage.getItem('selectedElectives') || '[]'); }
        catch { return []; }
    });
    useEffect(() => {
        try { localStorage.setItem('selectedElectives', JSON.stringify(electiveKeys)); }
        catch (e) { /* ignore */ }
    }, [electiveKeys]);
    const electiveSet = useMemo(() => new Set(electiveKeys), [electiveKeys]);
    function toggleElective(s: Slot) {
        const k = slotKey(s);
        setElectiveKeys(prev => prev.includes(k) ? prev.filter(x => x !== k) : [...prev, k]);
    }
    function selectAllElectives(opts: MergedRow[]) {
        setElectiveKeys(Array.from(new Set(opts.map(slotKey))));
    }
    function clearElectives() { setElectiveKeys([]); }

    const electiveRows = useMemo(
        () => (merged ? merged.filter(r => isElectiveTitle(r.title)) : null),
        [merged]
    );

    // --- INDEX "Cvičenia z voliteľných predmetov" ---
    const [electiveIndex, setElectiveIndex] = useState<ElectiveLink[] | null>(null);
    const [idxLoading, setIdxLoading] = useState(false);

    async function loadElectiveIndex() {
        try {
            setIdxLoading(true);
            const html = await fetchHtmlThroughCors(ALADIN_BASE);
            const doc = new DOMParser().parseFromString(html, 'text/html');

            // Nájdeme tabuľku s nadpisom "Cvičenia z voliteľných predmetov"
            const tables = Array.from(doc.querySelectorAll('table'));
            const links: ElectiveLink[] = [];
            for (const tbl of tables) {
                const maybeHeading = tbl.querySelector('th');
                const heading = (maybeHeading?.textContent || '').trim().toLowerCase();
                if (!heading.includes('cvičenia z voliteľných')) continue;

                const as = Array.from(tbl.querySelectorAll('a[href]')) as HTMLAnchorElement[];
                for (const a of as) {
                    const code = (a.textContent || '').trim();
                    let url = a.getAttribute('href') || '';
                    if (!url) continue;
                    if (!/^https?:/i.test(url)) url = new URL(url, ALADIN_BASE).toString();
                    links.push({ code, url });
                }
            }
            setElectiveIndex(links);
        } catch (e) {
            console.error('[electiveIndex] parse failed', e);
            setElectiveIndex([]);
        } finally {
            setIdxLoading(false);
        }
    }

    // --- Balíky pridaných voliteľných predmetov z indexu ---
    const [extraPacks, setExtraPacks] = useState<Record<string, MergedRow[]>>({});
    const extraRows = useMemo(() => Object.values(extraPacks).flat(), [extraPacks]);
    const extraKeySet = useMemo(() => new Set(extraRows.map(slotKey)), [extraRows]);

    async function addElectivePack(link: ElectiveLink) {
        const code = link.code; // napr. 1bc_API_ENVI
        if (extraPacks[code]) return; // už pridané
        try {
            const html = await fetchHtmlThroughCors(link.url);
            const slots = parseScheduleFromHtml(html, link.url);
            // MergedRow s "groups" = [code]
            const mergedRows = mergeRows(slots.map(s => ({ ...s, groups: [code] })));
            setExtraPacks(prev => ({ ...prev, [code]: mergedRows }));
        } catch (e) {
            console.error('[addElectivePack] failed', code, e);
        }
    }
    function removeElectivePack(code: string) {
        setExtraPacks(prev => {
            const copy = { ...prev };
            delete copy[code];
            return copy;
        });
    }

    // --- odvodené: dostupné odkazy pre aktuálny ročník ---
    const electiveLinksForYear = useMemo(() => {
        if (!electiveIndex || !sel.year) return [];
        // normalizuj "1 bc" -> "1bc"
        const { num, kind } = parseYear(sel.year);
        const prefix = `${num}${kind}`.toLowerCase(); // 1bc, 2i, ...
        return electiveIndex.filter(l => l.code.toLowerCase().startsWith(prefix + '_'));
    }, [electiveIndex, sel.year]);

    // --- Zjednotený viditeľný zoznam ---
    const visibleMerged = useMemo(() => {
        if (!merged && extraRows.length === 0) return null;
        const base = merged ?? [];
        const union = mergeRows([...base, ...extraRows]);
        // filter: hidden, a '@' checkboxy len pre riadky NEpochádzajúce z extraPacks
        const out: MergedRow[] = [];
        for (const r of union) {
            const k = slotKey(r);
            if (hiddenSet.has(k)) continue;
            const isExtra = extraKeySet.has(k);
            if (!isExtra && isElectiveTitle(r.title)) {
                if (!electiveSet.has(k)) continue;
            }
            out.push(r);
        }
        return out;
    }, [merged, extraRows, hiddenSet, electiveSet, extraKeySet]);

    type FlatGroup = { year: string; program: string; label: string; url: string };

    const allGroupsFlat = useMemo<FlatGroup[]>(() => {
        if (!catalog) return [];
        const out: FlatGroup[] = [];
        for (const year of Object.keys(catalog)) {
            for (const program of Object.keys(catalog[year] ?? {})) {
                for (const g of catalog[year]?.[program] ?? []) {
                    out.push({ year, program, label: g.label, url: g.url });
                }
            }
        }
        return out;
    }, [catalog]);

    // pridané „ANY:“ balíky podľa názvu predmetu (globálne vyhľadanie)
    const addedAnyTitles = useMemo(() =>
        new Set(
            Object.keys(extraPacks)
                .filter(k => k.startsWith('ANY:'))
                .map(k => k.slice(4))
        ), [extraPacks]);

    function addAnyPack(title: string, rows: MergedRow[]) {
        const code = `ANY:${title}`;
        // rows už sú zlúčené; pre istotu ešte merge
        const merged = mergeRows(rows);
        setExtraPacks(prev => ({ ...prev, [code]: merged }));
    }

    function removeAnyPack(title: string) {
        const code = `ANY:${title}`;
        setExtraPacks(prev => {
            const copy = { ...prev };
            delete copy[code];
            return copy;
        });
    }

    // --- Lifecycle ---
    useEffect(() => { void loadIndex(); void loadElectiveIndex(); }, []);

    async function loadIndex() {
        setLoading(true); setErr(null);
        try {
            const cat = await fetchCatalog();
            setCatalog(cat);
            const years = sortYears(Object.keys(cat));
            const firstYear = years[0];
            const progs = firstYear ? sortPrograms(Object.keys(cat[firstYear])) : [];
            setSel({ year: firstYear, program: progs[0] });
            setMerged(null);
            setExtraPacks({}); // reset extra po novom loade
        } catch (e: unknown) {
            setErr(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }

    const yearsSorted = useMemo(() => catalog ? sortYears(Object.keys(catalog)) : [], [catalog]);
    const programsForYear = useMemo(() => {
        if (!catalog || !sel.year) return [];
        return sortPrograms(Object.keys(catalog[sel.year] ?? {}));
    }, [catalog, sel.year]);

    const groups = useMemo(() => {
        if (!catalog || !sel.year || !sel.program) return [];
        return catalog[sel.year]?.[sel.program] ?? [];
    }, [catalog, sel.year, sel.program]);

    function onYearChange(year: string) {
        const nextProgram = catalog && catalog[year]
            ? sortPrograms(Object.keys(catalog[year]))[0]
            : undefined;
        setSel({ year, program: nextProgram });
        setMerged(null);
        setExtraPacks({});  // reset extra pri zmene ročníka
        // voliteľné checkboxy nechávam – kľudne si pridaj reset, ak chceš:
        // setElectiveKeys([]); setHiddenKeys([]);
    }
    function onProgramChange(program: string) {
        setSel(prev => ({ ...prev, program }));
        setMerged(null);
        setExtraPacks({}); // reset extra pri zmene programu
    }

    async function buildMerged() {
        if (!groups.length) return;
        setMerging(true); setErr(null); setMerged(null);

        const urlToLabel = new Map<string, string>(groups.map(g => [g.url, g.label]));
        try {
            const slots: Slot[] = [];
            const concurrency = 3;
            let idx = 0;

            async function worker(id: number) {
                while (idx < groups.length) {
                    const my = idx++;
                    const g = groups[my];
                    console.groupCollapsed(`[merge] worker ${id} → ${g.label}`);
                    try {
                        const html = await fetchHtmlThroughCors(g.url);
                        console.log('[merge] html size=', html.length);
                        const parsed = parseScheduleFromHtml(html, g.url);
                        console.log('[merge] parsed slots=', parsed.length);
                        console.table(parsed.slice(0, 5).map(s => ({
                            day: s.day,
                            start: formatHM(s.startMin),
                            end: formatHM(s.endMin),
                            title: s.title,
                            room: s.room ?? '',
                        })));
                        slots.push(...parsed);
                    } catch (e) {
                        console.error('[merge] error for', g.label, e);
                    } finally {
                        console.groupEnd();
                    }
                }
            }

            await Promise.all(
                Array.from({ length: Math.min(concurrency, groups.length) }, (_, i) => worker(i))
            );

            console.log('[merge] total slots before merge=', slots.length);

            const map = new Map<string, MergedRow>();
            for (const s of slots) {
                const k = slotKey(s);
                const row = map.get(k);
                const glabel = urlToLabel.get(s.sourceUrl) ?? s.sourceUrl;
                if (!row) {
                    map.set(k, { ...s, groups: [glabel] });
                } else {
                    if (!row.groups.includes(glabel)) row.groups.push(glabel);
                }
            }

            const dayOrder: Record<string, number> = { 'Pon': 0, 'Uto': 1, 'Str': 2, 'Stv': 3, 'Pia': 4 };
            const mergedRows = [...map.values()].sort((a, b) =>
                (dayOrder[a.day] - dayOrder[b.day]) || (a.startMin - b.startMin) || a.title.localeCompare(b.title)
            );

            setMerged(mergedRows);
        } catch (e: unknown) {
            setErr(e instanceof Error ? e.message : String(e));
        } finally {
            setMerging(false);
        }
    }

    return (
        <main className="container">
            <header className="header">
                <h1 className="title">FEI STU – výber rozvrhu</h1>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={loadIndex} disabled={loading} className="btn btn-ghost">
                        {loading ? 'Načítavam…' : 'Obnoviť zoznam'}
                    </button>
                    <button
                        onClick={buildMerged}
                        disabled={!groups.length || merging}
                        className="btn btn-primary"
                        title="Zlúčiť všetky krúžky pre zvolený ročník a odbor"
                    >
                        {merging ? 'Zlučujem…' : 'Zobraziť rozvrh'}
                    </button>
                </div>
            </header>

            {err && <p style={{ color: 'crimson', marginTop: 12 }}>Chyba: {err}</p>}

            {catalog && (
                <section className="controls">
                    <div className="fields">
                        <div className="field">
                            <label>Ročník</label>
                            <select
                                className="select"
                                value={sel.year ?? ''}
                                onChange={e => onYearChange(e.target.value)}
                            >
                                {yearsSorted.map(y => (
                                    <option key={y} value={y}>{prettyYearLabel(y)}</option>
                                ))}
                            </select>
                        </div>

                        <div className="field">
                            <label>Odbor / program {sel.year ? `(${prettyYearLabel(sel.year)})` : ''}</label>
                            <select
                                className="select"
                                disabled={!sel.year}
                                value={sel.program ?? ''}
                                onChange={e => onProgramChange(e.target.value)}
                            >
                                {programsForYear.map(p => (
                                    <option key={p} value={p}>{p}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <p className="helper">
                        {groups.length
                            ? <>Počet nájdených rozvrhov: <strong>{groups.length}</strong>. Klikni na „Zobraziť rozvrh“.</>
                            : <>Pre zvolenú kombináciu neboli nájdené žiadne rozvrhy.</>}
                    </p>

                    {merged && (
                        <div>
                            {visibleMerged && visibleMerged.length === 0 ? (
                                <p className="helper">Po odfiltrovaní neostali žiadne položky.</p>
                            ) : (
                                <>

                                    {visibleMerged && visibleMerged.length > 0 && (
                                        <div style={{marginTop: 24}}>
                                            <h2 className="section-title">Týždenný rozvrh</h2>
                                            <MergedGrid rows={visibleMerged} onRemove={hideSlot}/>
                                        </div>
                                    )}

                                    <h2 className="section-title">
                                        Zoznam prednášok a cvičení
                                    </h2>

                                    {hiddenSet.size > 0 && (
                                        <p className="helper" style={{ display:'flex', gap:8, alignItems:'center' }}>
                                            Skryté položky: <strong>{hiddenSet.size}</strong>
                                            <button className="btn btn-ghost btn-sm" onClick={resetHidden}>Obnoviť skryté</button>
                                        </p>
                                    )}

                                    {visibleMerged && <MergedTable rows={visibleMerged} onRemove={hideSlot}/>}
                                </>
                            )}


                            <h2 className="section-title">
                                Výber povinne voliteľných a voliteľných predmetov
                            </h2>
                            {merged && electiveRows && electiveRows.length > 0 && (
                                <ElectivesPanel
                                    options={electiveRows}
                                    selected={electiveSet}
                                    onToggle={toggleElective}
                                    onSelectAll={() => selectAllElectives(electiveRows)}
                                    onClear={clearElectives}
                                />
                            )}

                            {sel.year && (
                                <ElectiveAddPanel
                                    yearLabel={sel.year}
                                    loading={idxLoading && !electiveIndex}
                                    options={electiveLinksForYear}
                                    extraPacks={extraPacks}
                                    onAdd={addElectivePack}
                                    onRemove={removeElectivePack}
                                />
                            )}

                            {catalog && allGroupsFlat.length > 0 && (
                                <GlobalAddPanel
                                    allGroups={allGroupsFlat}
                                    addedTitles={addedAnyTitles}
                                    onAdd={addAnyPack}
                                    onRemove={removeAnyPack}
                                />
                            )}


                        </div>
                    )}
                </section>
            )}
        </main>
    );
}

/** ---- Pomocné funkcie: merge rovnakých slotov (spája groups) ---- */
function mergeRows(input: MergedRow[]): MergedRow[] {
    const map = new Map<string, MergedRow>();
    for (const s of input) {
        const k = slotKey(s);
        const ex = map.get(k);
        if (!ex) {
            map.set(k, { ...s, groups: [...s.groups] });
        } else {
            for (const g of s.groups) {
                if (!ex.groups.includes(g)) ex.groups.push(g);
            }
        }
    }
    // utried podľa dňa a času
    const dayOrder: Record<string, number> = { 'Pon': 0, 'Uto': 1, 'Str': 2, 'Stv': 3, 'Pia': 4 };
    return [...map.values()].sort((a, b) =>
        (dayOrder[a.day] - dayOrder[b.day]) || (a.startMin - b.startMin) || a.title.localeCompare(b.title)
    );
}

/** ---- Komponenty ---- */

function MergedTable({ rows, onRemove }: { rows: MergedRow[]; onRemove: (s: Slot) => void }) {
    const grouped = useMemo(() => {
        const byDay: Record<string, MergedRow[]> = {};
        for (const r of rows) (byDay[r.day] ||= []).push(r);
        return Object.entries(byDay).sort((a, b) => dayIndex(a[0]) - dayIndex(b[0]));
    }, [rows]);

    return (
        <div style={{ display: 'grid', gap: 16 }}>
            {grouped.map(([day, list]) => (
                <div key={day} className="day-card">
                    <div className="day-head">{day}</div>
                    <table className="table">
                        <thead>
                        <tr>
                            <th>Čas</th>
                            <th>Predmet</th>
                            <th>Miestnosť</th>
                            <th>Krúžky</th>
                            <th style={{ width: 48 }}></th>
                        </tr>
                        </thead>
                        <tbody>
                        {list
                            .sort((a, b) => a.startMin - b.startMin || a.title.localeCompare(b.title))
                            .map((r, i) => (
                                <tr key={i}>
                                    <td>{formatHM(r.startMin)}–{formatHM(r.endMin)}</td>
                                    <td>{r.title}</td>
                                    <td>{r.room ?? '—'}</td>
                                    <td><span title={r.groups.join(', ')}>{r.groups.length}</span></td>
                                    <td>
                                        <button
                                            type="button"
                                            className="btn btn-ghost btn-sm btn-danger"
                                            title="Odstrániť z náhľadu"
                                            onClick={() => onRemove(r)}
                                        >
                                            ×
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ))}
        </div>
    );
}

function MergedGrid({ rows, onRemove }: { rows: (Slot & { groups: string[] })[]; onRemove: (s: Slot) => void }) {
    const allStart = Math.min(...rows.map(r => r.startMin));
    const allEnd   = Math.max(...rows.map(r => r.endMin));
    const start = Math.min(7 * 60, Math.floor(allStart / 60) * 60 || 7 * 60);
    const end   = Math.max(20 * 60, Math.ceil(allEnd / 60) * 60 || 20 * 60);
    const hours = Array.from({ length: (end - start) / 60 }, (_, i) => start + i * 60);

    const days = ['Pon', 'Uto', 'Str', 'Stv', 'Pia'] as const;
    const byDay: Record<string, (Slot & { groups: string[] })[]> = {};
    for (const r of rows) (byDay[r.day] ||= []).push(r);

    function packLanes(list: (Slot & { groups: string[] })[]) {
        const sorted = [...list].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
        const lanes: (Slot & { groups: string[] })[][] = [];
        for (const s of sorted) {
            let placed = false;
            for (const lane of lanes) {
                const last = lane[lane.length - 1];
                if (!last || last.endMin <= s.startMin) { lane.push(s); placed = true; break; }
            }
            if (!placed) lanes.push([s]);
        }
        return lanes;
    }

    function pushGapCells(cells: JSX.Element[], fromMin: number, toMin: number) {
        const span = Math.max(0, Math.floor((toMin - fromMin) / 60));
        if (span > 0) cells.push(<td key={'g'+cells.length} colSpan={span} />);
    }

    function slotClass(title: string) {
        const t = title.trim();
        const isElective = t.startsWith('@') || t.startsWith('#');
        const isUpper = t === t.toUpperCase();
        return 'slot ' + (isElective ? 'slot-elective' : isUpper ? 'slot-lecture' : 'slot-class');
    }

    function renderCell(s: Slot & { groups: string[] }, key: string) {
        const span = Math.max(1, Math.floor((s.endMin - s.startMin) / 60));
        const title = s.title;
        const subtitle = s.room ?? '—';
        const tip = `${s.day} ${formatHM(s.startMin)}–${formatHM(s.endMin)} · ${title}${s.room ? ' · '+s.room : ''}\nKrúžky: ${s.groups.join(', ')}`;
        return (
            <td key={key} colSpan={span} className={slotClass(title)} title={tip}>
                <button
                    type="button"
                    className="slot-remove"
                    aria-label="Odstrániť"
                    onClick={(e) => { e.stopPropagation(); onRemove(s); }}
                    title="Odstrániť z náhľadu"
                >
                    ×
                </button>
                <div className="slot-title">{title}</div>
                <div className="slot-sub">{subtitle}</div>
            </td>
        );
    }

    return (
        <div className="grid-wrapper">
            <table className="weekgrid">
                <thead>
                <tr>
                    <th className="grid-first">Hod<br/>Zač</th>
                    {hours.map((h, i) => (
                        <th key={i}>
                            <div style={{ fontWeight: 700 }}>{i + 1}</div>
                            <div className="grid-time">{formatHM(h)}</div>
                        </th>
                    ))}
                </tr>
                </thead>
                <tbody>
                {days.map(day => {
                    const list = byDay[day] ?? [];
                    if (list.length === 0) {
                        return (
                            <tr key={day}>
                                <td className="grid-day">{day}</td>
                                {hours.map((_, i) => <td key={i} />)}
                            </tr>
                        );
                    }
                    const lanes = packLanes(list);
                    return lanes.map((lane, li) => {
                        const cells: JSX.Element[] = [];
                        let cursor = start;
                        for (const s of lane) {
                            pushGapCells(cells, cursor, s.startMin);
                            cells.push(renderCell(s, `${s.title}-${s.startMin}-${s.endMin}-${cells.length}`));
                            cursor = s.endMin;
                        }
                        pushGapCells(cells, cursor, end);

                        return (
                            <tr key={day + '-' + li}>
                                {li === 0 && <td className="grid-day" rowSpan={lanes.length}>{day}</td>}
                                {cells}
                            </tr>
                        );
                    });
                })}
                </tbody>
            </table>
        </div>
    );
}

function ElectivesPanel({
                            options,
                            selected,
                            onToggle,
                            onSelectAll,
                            onClear,
                        }: {
    options: MergedRow[];
    selected: Set<string>;
    onToggle: (s: Slot) => void;
    onSelectAll: () => void;
    onClear: () => void;
}) {
    const dayOrder: Record<string, number> = { Pon: 0, Uto: 1, Str: 2, Stv: 3, Pia: 4 };
    const sorted = useMemo(
        () => [...options].sort(
            (a, b) => (dayOrder[a.day]-dayOrder[b.day]) || (a.startMin-b.startMin) || a.title.localeCompare(b.title)
        ),
        [options]
    );

    return (
        <div className="day-card" style={{ marginTop: 12 }}>
            <div className="day-head" style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                <span>(Povinne) Voliteľné predmety</span>
                <div style={{ display:'flex', gap:8 }}>
                    <button className="btn btn-ghost btn-sm" onClick={onSelectAll}>Vybrať všetky</button>
                    <button className="btn btn-ghost btn-sm" onClick={onClear}>Zrušiť výber</button>
                </div>
            </div>
            <table className="table">
                <thead>
                <tr>
                    <th style={{ width: 36 }}></th>
                    <th>Deň</th>
                    <th>Čas</th>
                    <th>Predmet</th>
                    <th>Miestnosť</th>
                    <th>Krúžky</th>
                </tr>
                </thead>
                <tbody>
                {sorted.map((r, i) => {
                    const k = slotKey(r);
                    const checked = selected.has(k);
                    return (
                        <tr key={i}>
                            <td>
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => onToggle(r)}
                                    title={checked ? 'Odstrániť z výberu' : 'Pridať do výberu'}
                                />
                            </td>
                            <td>{r.day}</td>
                            <td>{formatHM(r.startMin)}–{formatHM(r.endMin)}</td>
                            <td>{r.title}</td>
                            <td>{r.room ?? '—'}</td>
                            <td><span title={r.groups.join(', ')}>{r.groups.length}</span></td>
                        </tr>
                    );
                })}
                </tbody>
            </table>
            <p className="helper" style={{ margin: '8px 12px 12px' }}>
                Zaškrtnuté položky sa pridajú do tabuľky aj týždenného gridu. Nezaškrtnuté zostanú skryté.
            </p>
        </div>
    );
}

/** Panel na pridanie cvičení z voliteľných predmetov (z indexu) */
function ElectiveAddPanel({
                              yearLabel,
                              loading,
                              options,
                              extraPacks,
                              onAdd,
                              onRemove,
                          }: {
    yearLabel: string;
    loading: boolean;
    options: ElectiveLink[];
    extraPacks: Record<string, MergedRow[]>;
    onAdd: (link: ElectiveLink) => void;
    onRemove: (code: string) => void;
}) {
    const [q, setQ] = useState('');

    const filtered = useMemo(() => {
        const base = options;
        if (!q.trim()) return base;
        const needle = q.trim().toLowerCase();
        return base.filter(o => o.code.toLowerCase().includes(needle));
    }, [options, q]);

    return (
        <div className="day-card" style={{ marginTop: 12 }}>
            <div className="day-head" style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                <span>Pridať cvičenia z voliteľných predmetov – {prettyYearLabel(yearLabel)}</span>
                {loading && <span className="helper">Načítavam zoznam…</span>}
            </div>

            <div style={{ padding: 12, display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                <input
                    className="input"
                    placeholder="Hľadať podľa kódu (napr. API_ENVI)…"
                    value={q}
                    onChange={e => setQ(e.target.value)}
                    style={{ maxWidth: 360 }}
                />
            </div>

            <table className="table">
                <thead>
                <tr>
                    <th>Kód</th>
                    <th style={{ width: 160 }}></th>
                </tr>
                </thead>
                <tbody>
                {filtered.length === 0 ? (
                    <tr><td colSpan={2} className="helper">Pre tento ročník sa nenašli položky.</td></tr>
                ) : (
                    filtered.map((l) => {
                        const added = !!extraPacks[l.code];
                        return (
                            <tr key={l.code}>
                                <td><code>{l.code}</code></td>
                                <td style={{ textAlign:'right' }}>
                                    {added ? (
                                        <button className="btn btn-ghost btn-sm btn-danger" onClick={() => onRemove(l.code)}>
                                            Odobrať
                                        </button>
                                    ) : (
                                        <button className="btn btn-ghost btn-sm" onClick={() => onAdd(l)}>
                                            Pridať
                                        </button>
                                    )}
                                </td>
                            </tr>
                        );
                    })
                )}
                </tbody>
            </table>

            {Object.keys(extraPacks).length > 0 && (
                <p className="helper" style={{ margin: '8px 12px 12px' }}>
                    Pridané: {Object.keys(extraPacks).map(k => <code key={k} style={{ marginRight: 8 }}>{k}</code>)}
                </p>
            )}
        </div>
    );
}

function GlobalAddPanel({
                            allGroups,
                            addedTitles,
                            onAdd,
                            onRemove,
                        }: {
    allGroups: { year: string; program: string; label: string; url: string }[];
    addedTitles: Set<string>;
    onAdd: (title: string, rows: MergedRow[]) => void;
    onRemove: (title: string) => void;
}) {
    const years = useMemo(() => {
        const s = new Set<string>(allGroups.map(g => g.year));
        return sortYears([...s]);
    }, [allGroups]);

    const [year, setYear] = useState<string>('ALL');
    const programs = useMemo(() => {
        if (year === 'ALL') return [];
        const s = new Set<string>(allGroups.filter(g => g.year === year).map(g => g.program));
        return sortPrograms([...s]);
    }, [allGroups, year]);

    const [program, setProgram] = useState<string>('ALL');
    useEffect(() => { setProgram('ALL'); }, [year]);

    const [q, setQ] = useState('');
    const [loading, setLoading] = useState(false);
    const [progress, setProgress] = useState<{done:number; total:number}>({done:0, total:0});

    // cache načítaných stránok (URL -> Slot[])
    const [cache, setCache] = useState<Record<string, Slot[]>>({});

    // výsledky: title -> zlúčené riadky
    const [results, setResults] = useState<Array<{ title: string; rows: MergedRow[] }>>([]);

    const filteredGroups = useMemo(() => {
        let src = allGroups;
        if (year !== 'ALL') src = src.filter(g => g.year === year);
        if (program !== 'ALL') src = src.filter(g => g.program === program);
        return src;
    }, [allGroups, year, program]);

    async function runSearch() {
        const needle = q.trim().toLowerCase();
        if (!needle) {
            setResults([]);
            return;
        }

        setLoading(true);
        setProgress({done:0, total: filteredGroups.length});

        const perTitle: Map<string, MergedRow[]> = new Map();
        let idx = 0;
        const concurrency = 4;

        async function processGroup(g: {label: string; url: string}) {
            try {
                let slots = cache[g.url];
                if (!slots) {
                    const html = await fetchHtmlThroughCors(g.url);
                    slots = parseScheduleFromHtml(html, g.url);
                    setCache(prev => ({ ...prev, [g.url]: slots }));
                }

                // vyber len tie sloty, kde title obsahuje hľadaný reťazec
                const picked = slots.filter(s => (s.title || '').toLowerCase().includes(needle));

                for (const s of picked) {
                    const titleKey = s.title.trim().toUpperCase();
                    const arr = perTitle.get(titleKey) || [];
                    arr.push({ ...s, groups: [g.label] }); // pripíš zdrojový „krúžok“
                    perTitle.set(titleKey, arr);
                }
            } catch (e) {
                // swallow; pokračuj
            } finally {
                setProgress(prev => ({done: prev.done + 1, total: prev.total}));
            }
        }

        async function worker() {
            while (true) {
                const my = idx++;
                if (my >= filteredGroups.length) break;
                const g = filteredGroups[my];
                await processGroup(g);
            }
        }

        await Promise.all(Array.from({ length: Math.min(concurrency, filteredGroups.length) }, worker));

        // Zlúč v rámci rovnakého názvu (spoj groups, odstráň duplicity)
        const list: Array<{ title: string; rows: MergedRow[] }> = [];
        for (const [k, arr] of perTitle.entries()) {
            const merged = mergeRows(arr);
            // k ako uppercase; skús vybrať displayTitle (najdlhší, resp. prvý)
            const displayTitle = merged.length ? merged[0].title : k;
            list.push({ title: displayTitle, rows: merged });
        }
        // utried abecedne
        list.sort((a, b) => a.title.localeCompare(b.title, 'sk'));

        setResults(list);
        setLoading(false);
    }

    return (
        <div className="day-card" style={{ marginTop: 12 }}>
            <div className="day-head" style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, flexWrap:'wrap' }}>
                <span>Pridať predmet z hociktorého odboru / ročníka</span>
                {loading ? (
                    <span className="helper">Prehľadávam… {progress.done}/{progress.total}</span>
                ) : null}
            </div>

            <div style={{ padding: 12, display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                <select className="select" value={year} onChange={e => setYear(e.target.value)}>
                    <option value="ALL">Všetky ročníky</option>
                    {years.map(y => <option key={y} value={y}>{prettyYearLabel(y)}</option>)}
                </select>
                <select className="select" value={program} onChange={e => setProgram(e.target.value)} disabled={year==='ALL'}>
                    <option value="ALL">{year==='ALL' ? 'Vyber ročník' : 'Všetky programy'}</option>
                    {programs.map(p => <option key={p} value={p}>{p}</option>)}
                </select>

                <input
                    className="input"
                    placeholder="Hľadať predmet (napr. MAT, PROG,...)"
                    value={q}
                    onChange={e => setQ(e.target.value)}
                    style={{ minWidth: 260 }}
                />
                <button className="btn btn-ghost" onClick={runSearch} disabled={loading || !q.trim()}>
                    {loading ? 'Hľadám…' : 'Hľadať'}
                </button>
            </div>

            <table className="table">
                <thead>
                <tr>
                    <th>Predmet</th>
                    <th>Výskyty</th>
                    <th style={{ width: 180 }}></th>
                </tr>
                </thead>
                <tbody>
                {!q.trim() ? (
                    <tr><td colSpan={3} className="helper">Zadaj hľadaný reťazec a klikni „Hľadať“.</td></tr>
                ) : loading && results.length === 0 ? (
                    <tr><td colSpan={3} className="helper">Hľadám…</td></tr>
                ) : results.length === 0 ? (
                    <tr><td colSpan={3} className="helper">Nenašli sa žiadne položky.</td></tr>
                ) : (
                    results.map(r => {
                        const added = addedTitles.has(r.title);
                        const summary = r.rows
                            .slice(0, 3)
                            .map(s => `${s.day} ${formatHM(s.startMin)}–${formatHM(s.endMin)}`)
                            .join(', ') + (r.rows.length > 3 ? '…' : '');
                        return (
                            <tr key={r.title}>
                                <td><b>{r.title}</b><div className="helper">{summary || '—'}</div></td>
                                <td>{r.rows.length}</td>
                                <td style={{ textAlign:'right' }}>
                                    {added ? (
                                        <button className="btn btn-ghost btn-sm btn-danger" onClick={() => onRemove(r.title)}>
                                            Odobrať
                                        </button>
                                    ) : (
                                        <button className="btn btn-ghost btn-sm" onClick={() => onAdd(r.title, r.rows)}>
                                            Pridať
                                        </button>
                                    )}
                                </td>
                            </tr>
                        );
                    })
                )}
                </tbody>
            </table>

            {addedTitles.size > 0 && (
                <p className="helper" style={{ margin: '8px 12px 12px' }}>
                    Pridané (globálne): {[...addedTitles].map(t => <code key={t} style={{ marginRight: 8 }}>{t}</code>)}
                </p>
            )}
        </div>
    );
}

/** --- util triedenia --- */
function sortYears(years: string[]): string[] {
    return [...years].sort((a, b) => {
        const pa = parseYear(a); const pb = parseYear(b);
        if (pa.num !== pb.num) return pa.num - pb.num;
        if (pa.kind !== pb.kind) return kindOrder(pa.kind) - kindOrder(pb.kind);
        return a.localeCompare(b);
    });
}
function parseYear(y: string): { num: number; kind: string } {
    const m = y.match(/^(\d+)\s*([a-z]+)/i);
    return { num: m ? Number(m[1]) : 0, kind: m ? m[2].toLowerCase() : '' };
}
function kindOrder(kind: string): number { return kind === 'bc' ? 0 : kind === 'i' ? 1 : 2; }
function sortPrograms(p: string[]): string[] { return [...p].sort((a, b) => a.localeCompare(b, 'sk', { numeric: true })); }
function dayIndex(d: string): number {
    const order: Record<string, number> = { Pon: 0, Uto: 1, Str: 2, Stv: 3, Pia: 4 };
    return d in order ? order[d] : 9;
}