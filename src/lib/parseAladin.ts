export type Day = 'Pon' | 'Uto' | 'Str' | 'Stv' | 'Pia';
export type ParsedItem = { day: Day; title: string; room?: string; raw: string };

const DAY_RE = /^\s*(Pon|Uto|Str|Stv|Štv|Pia)\b.*$/;
const ROOM_RE = /\b[a-z]{1,2}\d{2,3}[a-z]?\b/gi;
const TITLE_RE = /[@#]?[A-Za-z0-9]{3,}[-A-Za-z0-9]*/g;

export function parseAladinPlainText(txt: string): ParsedItem[] {
    const normalized = txt.replace(/\r/g, '').replace(/\u00A0/g, ' ');
    const lines = normalized.split('\n');
    const items: ParsedItem[] = [];
    const dayOrder: Day[] = ['Pon','Uto','Str','Stv','Pia'];

    let i = lines.findIndex(l => DAY_RE.test(l));
    while (i >= 0 && i < lines.length) {
        const dayLine = lines[i];
        const dayRaw = dayLine.match(/(Pon|Uto|Str|Stv|Štv|Pia)/)?.[1] ?? '';
        const day = (dayRaw.startsWith('Š') ? 'Stv' : dayRaw) as Day;
        if (!dayOrder.includes(day)) { i++; continue; }

        const block: string[] = [dayLine];
        let j = i + 1;
        for (; j < lines.length; j++) {
            if (DAY_RE.test(lines[j])) break;
            if (/^Meno pred|^Generovan|^Generované/i.test(lines[j])) break;
            block.push(lines[j]);
        }
        const textBlock = block.join('\n');

        const titles = [...textBlock.matchAll(TITLE_RE)]
            .map(m => m[0])
            .filter(t => !/^(Hod|Zac)$/i.test(t));
        const rooms  = [...textBlock.matchAll(ROOM_RE)].map(m => m[0]);

        for (const t of titles) {
            const lineWithT = block.find(b => b.includes(t)) ?? '';
            const room = (lineWithT.match(ROOM_RE) ?? [])[0] ?? rooms.find(r => textBlock.indexOf(r) > textBlock.indexOf(t));
            items.push({ day, title: t, room: room ?? undefined, raw: lineWithT.trim() });
        }

        i = j;
    }
    return items;
}