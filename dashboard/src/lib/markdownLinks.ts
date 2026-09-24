/** Final dotted segments that read as file-extension-style product names (Node.js, Next.js), not domains. */
const FILE_EXTENSION_LIKE = new Set(['js', 'ts', 'py', 'md', 'rs', 'go', 'rb']);

/** True when a link's visible text is just a bare domain (e.g. "reuters.com"), so it can render as a small pill. */
export function isDomainLabel(text: string): boolean {
  const trimmed = text.trim();
  if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(trimmed)) return false;
  const parts = trimmed.split('.');
  const last = parts[parts.length - 1].toLowerCase();
  return !FILE_EXTENSION_LIKE.has(last);
}
