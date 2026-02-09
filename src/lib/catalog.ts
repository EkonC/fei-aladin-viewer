// src/lib/catalog.ts
import { fetchHtmlThroughCors } from './fetchHtml';

export const ALADIN_BASE = 'https://rozvrhy.fei.stuba.sk/';

export type YearKey = string;        // napr. "1bc", "2bc", "1i", ...
export type ProgramCode = string;    // napr. "API", "RK", "IKT", ...
export type Group = { label: string; url: string; group: string };
export type Catalog = Record<YearKey, Record<ProgramCode, Group[]>>;

//  .../rozvrh/1bc_API_1.html  alebo len 1bc_API_1.html
const HREF_RE = /(?:^|\/)(([1-5](?:bc|i))_([A-Za-z0-9]+)_(\d+))\.html$/i;

function absolutize(href: string): string {
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith('/')) return new URL(href, ALADIN_BASE).toString();
    return ALADIN_BASE + href;
}

export async function fetchCatalog(): Promise<Catalog> {
    const html = await fetchHtmlThroughCors(ALADIN_BASE);

    // Naparsuj HTML indexu cez DOMParser (bežíme v prehliadači)
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const anchors = Array.from(doc.querySelectorAll('a[href]')) as HTMLAnchorElement[];

    const cat: Catalog = {} as Catalog;

    for (const a of anchors) {
        const href = a.getAttribute('href') ?? '';
        if (!href) continue;

        const text = a.textContent ?? '';
        const hay = (text + ' ' + href).toLowerCase();

        // hrubý filter – ignoruj odkazy, ktoré zjavne súvisia s voliteľkami/cvičeniami
        if (hay.includes('voľit') || hay.includes('volit') || hay.includes('cvičen') || hay.includes('cvicen')) {
            continue;
        }

        // Skús vyparsovať „1bc_API_1“ z href-u alebo z textu
        const m = href.match(HREF_RE) || text.match(HREF_RE);
        if (!m) continue;

        const fullLabel = m[1];                // 1bc_API_1
        const year = m[2].toLowerCase();       // 1bc
        const program = m[3].toUpperCase();    // API
        const group = m[4];                    // 1
        const url = absolutize(href);

        cat[year] ||= {} as Record<ProgramCode, Group[]>;
        cat[year][program] ||= [];

        // deduplikácia
        if (!cat[year][program].some(g => g.url === url)) {
            cat[year][program].push({ label: fullLabel, url, group });
        }
    }

    // usporiadanie krúžkov
    for (const year of Object.keys(cat)) {
        for (const prog of Object.keys(cat[year])) {
            cat[year][prog].sort((a, b) => Number(a.group) - Number(b.group));
        }
    }

    return cat;
}

export function prettyYearLabel(year: string): string {
    const m = year.match(/^(\d+)\s*([a-z]+)/i);
    if (!m) return year;
    const n = m[1];
    const kind = m[2].toLowerCase();
    if (kind === 'bc') return `${n}. BC`;
    if (kind === 'i')  return `${n}. Ing.`;
    return `${n}. ${kind.toUpperCase()}`;
}