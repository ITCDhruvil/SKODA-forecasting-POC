import {
  sanitizeCharts,
  sanitizeExports,
  sanitizeSources,
  type ChartSpec,
  type ChatSource,
  type ExportOffer,
} from './chatHistory';

export type ChatMode = 'data' | 'web' | 'action';

export type ChatStreamEvent =
  | { type: 'mode'; mode: ChatMode }
  | {
      type: 'result';
      reply: string;
      mode: ChatMode;
      usedWeb: boolean;
      sources: ChatSource[];
      charts: ChartSpec[];
      exports: ExportOffer[];
    }
  | { type: 'error'; error: string };

const MODES: readonly ChatMode[] = ['data', 'web', 'action'];
function isMode(v: unknown): v is ChatMode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v);
}

/** Parses one NDJSON line into a validated event; anything malformed returns null (never throws). */
export function parseChatEvent(line: string): ChatStreamEvent | null {
  const text = line.trim();
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  if (o.type === 'mode') {
    return isMode(o.mode) ? { type: 'mode', mode: o.mode } : null;
  }
  if (o.type === 'result') {
    if (typeof o.reply !== 'string' || !isMode(o.mode)) return null;
    return {
      type: 'result',
      reply: o.reply,
      mode: o.mode,
      usedWeb: o.usedWeb === true,
      sources: sanitizeSources(o.sources),
      charts: sanitizeCharts(o.charts),
      exports: sanitizeExports(o.exports),
    };
  }
  if (o.type === 'error') {
    return typeof o.error === 'string' ? { type: 'error', error: o.error } : null;
  }
  return null;
}

/** Appends a decoded chunk to the buffer and returns the complete lines plus the unfinished remainder. */
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (buffer + chunk).split('\n');
  const rest = parts.pop() ?? '';
  const lines = parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter((l) => l.length > 0);
  return { lines, rest };
}

/** Reads an NDJSON body and calls onEvent for every valid event, in order. Handles lines split across chunks. */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: ChatStreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  function emit(line: string) {
    const event = parseChatEvent(line);
    if (event) onEvent(event);
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const { lines, rest } = splitLines(buffer, decoder.decode(value, { stream: true }));
      buffer = rest;
      for (const line of lines) emit(line);
    }
    // Flush the decoder's pending bytes and any last line that had no trailing newline.
    const { lines, rest } = splitLines(buffer, decoder.decode());
    for (const line of lines) emit(line);
    const last = rest.endsWith('\r') ? rest.slice(0, -1) : rest;
    if (last) emit(last);
  } finally {
    reader.releaseLock();
  }
}
