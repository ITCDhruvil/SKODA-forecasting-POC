export interface WebSource {
  title: string;
  url: string;
  domain: string;
}

/** Trusted outlets Radar may search. Edit this list to change coverage. Domains only, no scheme; subdomains match. */
export const ALLOWED_DOMAINS: string[] = [
  // wire / business
  'reuters.com',
  'ft.com',
  'bloomberg.com',
  'wsj.com',
  // automotive
  'autonews.com',
  'just-auto.com',
  'automotivelogistics.media',
  'skoda-storyboard.com',
  'volkswagen-group.com',
  // supply chain / trade
  'supplychaindive.com',
  'spglobal.com',
  'argusmedia.com',
  'fastmarkets.com',
  'mining.com',
  // institutions / policy
  'europa.eu',
  'ecb.europa.eu',
  'wto.org',
  'imf.org',
  'worldbank.org',
  // India (SKODA India context)
  'economictimes.indiatimes.com',
  'livemint.com',
  'business-standard.com',
];

const MAX_TITLE_LENGTH = 200;

export function isAllowedHost(hostname: string, domains: readonly string[] = ALLOWED_DOMAINS): boolean {
  const host = hostname.toLowerCase();
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

export function toWebSource(
  rawUrl: string,
  title: string | undefined,
  domains: readonly string[] = ALLOWED_DOMAINS,
): WebSource | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!isAllowedHost(parsed.hostname, domains)) return null;

  parsed.searchParams.delete('utm_source');
  parsed.hash = '';
  const domain = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const cleanTitle = (title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
  return { title: cleanTitle || domain, url: parsed.toString(), domain };
}

export function dedupeSources(sources: WebSource[]): WebSource[] {
  const seen = new Set<string>();
  const out: WebSource[] = [];
  for (const s of sources) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out;
}
