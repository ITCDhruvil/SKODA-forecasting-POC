/** True when a link's visible text is just a bare domain (e.g. "reuters.com"), so it can render as a small pill. */
export function isDomainLabel(text: string): boolean {
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(text.trim());
}
