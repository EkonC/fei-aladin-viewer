// Robustný fetch cez viac proxy s fallbackom
type ProxyKind = 'allorigins' | 'codetabs' | 'isogit';

const buildUrl = (kind: ProxyKind, target: string) => {
    switch (kind) {
        case 'allorigins':
            // JSON endpoint – vráti { contents: "...html..." }
            return `https://api.allorigins.win/get?disableCache=true&url=${encodeURIComponent(target)}`;
        case 'codetabs':
            // Vráti priamo telá odpovedí (text/HTML)
            return `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`;
        case 'isogit':
            // Jednoduchý CORS proxy (GET only). Zachová typy/hlavičky.
            return `https://cors.isomorphic-git.org/${target}`;
    }
};

export async function fetchHtmlThroughCors(url: string): Promise<string> {
    const chain: ProxyKind[] = ['codetabs', 'allorigins', 'isogit'];
    let lastError: unknown = null;

    for (const kind of chain) {
        try {
            const res = await fetch(buildUrl(kind, url), { method: 'GET' });
            if (!res.ok) throw new Error(`HTTP ${res.status} @ ${kind}`);

            if (kind === 'allorigins') {
                // JSON -> { contents: string, status: { url, content_type, ... } }
                const data: { contents?: string } = await res.json();
                if (!data.contents) throw new Error('Empty contents from allorigins');
                return data.contents;
            } else {
                return await res.text();
            }
        } catch (e) {
            lastError = e;
            // pokračuj na ďalší fallback
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}