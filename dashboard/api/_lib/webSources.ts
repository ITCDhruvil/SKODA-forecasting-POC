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

const MIN_TITLE_LENGTH = 4;

/**
 * Readable title for a source the provider gave no title for (the search call lists consulted URLs
 * only): the last non-empty path segment, minus a file extension and a `_xx` language suffix, with
 * `-` and `_` turned into spaces. Falls back to the domain when the result is shorter than 4
 * characters or purely numeric. Returns '' when the url cannot be parsed.
 */
export function titleFromUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return '';
  }
  const domain = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const segment = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Malformed percent-encoding: use the raw segment.
  }
  const title = decoded
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/_[a-z]{2}$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH)
    .trim();
  return title.length < MIN_TITLE_LENGTH || /^[\d\s]+$/.test(title) ? domain : title;
}

/** Normalises a source url. A missing or blank `title` is replaced by one derived from the url; a given title wins. */
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
  return { title: cleanTitle || titleFromUrl(parsed.toString()) || domain, url: parsed.toString(), domain };
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
