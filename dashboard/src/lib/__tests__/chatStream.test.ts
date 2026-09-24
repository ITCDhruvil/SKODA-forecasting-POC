import { describe, it, expect } from 'vitest';
import { parseChatEvent, readChatStream, splitLines, type ChatStreamEvent } from '../chatStream';

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function collect(chunks: Uint8Array[]): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  await readChatStream(streamOf(chunks), (e) => events.push(e));
  return events;
}

const enc = new TextEncoder();

describe('parseChatEvent', () => {
  it('parses a mode event', () => {
    expect(parseChatEvent('{"type":"mode","mode":"web"}')).toEqual({ type: 'mode', mode: 'web' });
    expect(parseChatEvent('{"type":"mode","mode":"data"}')).toEqual({ type: 'mode', mode: 'data' });
    expect(parseChatEvent('{"type":"mode","mode":"action"}')).toEqual({ type: 'mode', mode: 'action' });
  });

  it('parses a result event', () => {
    const line = JSON.stringify({
      type: 'result',
      reply: 'Hello',
      mode: 'web',
      usedWeb: true,
      sources: [{ title: 'T', url: 'https://a.com/x', domain: 'a.com' }],
    });
    expect(parseChatEvent(line)).toEqual({
      type: 'result',
      reply: 'Hello',
      mode: 'web',
      usedWeb: true,
      sources: [{ title: 'T', url: 'https://a.com/x', domain: 'a.com' }],
      charts: [],
      exports: [],
    });
  });

  it('parses a result event carrying a valid chart', () => {
    const chart = {
      kind: 'donut',
      title: 't',
      unit: 'currency',
      currencySymbol: '₹',
      source: 's',
      slices: [{ label: 'A', value: 1 }],
    };
    const line = JSON.stringify({
      type: 'result',
      reply: 'Hello',
      mode: 'data',
      usedWeb: false,
      sources: [],
      charts: [chart],
    });
    const event = parseChatEvent(line);
    expect(event).toMatchObject({ type: 'result' });
    if (event?.type === 'result') expect(event.charts).toEqual([chart]);
  });

  it('returns charts: [] when the result line has no charts field at all', () => {
    const line = JSON.stringify({ type: 'result', reply: 'Hello', mode: 'data', usedWeb: false, sources: [] });
    const event = parseChatEvent(line);
    expect(event).toMatchObject({ type: 'result' });
    if (event?.type === 'result') expect(event.charts).toEqual([]);
  });

  it('drops an invalid chart but keeps the result event', () => {
    const line = JSON.stringify({
      type: 'result',
      reply: 'Hello',
      mode: 'data',
      usedWeb: false,
      sources: [],
      charts: [{ kind: 'pie', title: 't', unit: 'currency', currencySymbol: '₹', source: 's' }],
    });
    const event = parseChatEvent(line);
    expect(event).toMatchObject({ type: 'result' });
    if (event?.type === 'result') expect(event.charts).toEqual([]);
  });

  it('parses an error event', () => {
    expect(parseChatEvent('{"type":"error","error":"boom"}')).toEqual({ type: 'error', error: 'boom' });
  });

  it('drops sources with a non-http(s) url', () => {
    const line = JSON.stringify({
      type: 'result',
      reply: 'r',
      mode: 'web',
      usedWeb: true,
      sources: [
        { title: 'bad', url: 'javascript:alert(1)', domain: 'x' },
        { title: 'ok', url: 'https://ok.com', domain: 'ok.com' },
      ],
    });
    const event = parseChatEvent(line);
    expect(event).toMatchObject({ type: 'result' });
    if (event?.type === 'result') expect(event.sources).toEqual([{ title: 'ok', url: 'https://ok.com', domain: 'ok.com' }]);
  });

  it('treats a non-true usedWeb as false', () => {
    const line = JSON.stringify({ type: 'result', reply: 'r', mode: 'data', usedWeb: 'yes', sources: [] });
    const event = parseChatEvent(line);
    expect(event).toMatchObject({ type: 'result', usedWeb: false });
  });

  it('returns null for malformed input', () => {
    expect(parseChatEvent('')).toBeNull();
    expect(parseChatEvent('   ')).toBeNull();
    expect(parseChatEvent('not json')).toBeNull();
    expect(parseChatEvent('42')).toBeNull();
    expect(parseChatEvent('null')).toBeNull();
    expect(parseChatEvent('[1,2]')).toBeNull();
    expect(parseChatEvent('{"type":"nope"}')).toBeNull();
    expect(parseChatEvent('{"type":"mode","mode":"weird"}')).toBeNull();
    expect(parseChatEvent('{"type":"mode"}')).toBeNull();
    expect(parseChatEvent('{"type":"result","reply":1,"mode":"data","usedWeb":false,"sources":[]}')).toBeNull();
    expect(parseChatEvent('{"type":"result","reply":"r","mode":"nope","usedWeb":false,"sources":[]}')).toBeNull();
    expect(parseChatEvent('{"type":"error","error":5}')).toBeNull();
  });

  it('parses exports on a result event', () => {
    const event = parseChatEvent(
      JSON.stringify({
        type: 'result',
        reply: 'here you go',
        mode: 'data',
        exports: [{ format: 'xlsx', label: 'Alerts', dataRef: { export: 'alerts', params: {} } }],
      }),
    );
    expect(event).toMatchObject({ type: 'result', exports: [{ format: 'xlsx', label: 'Alerts' }] });
  });

  it('defaults exports to an empty array when the field is absent', () => {
    const event = parseChatEvent(JSON.stringify({ type: 'result', reply: 'hi', mode: 'data' }));
    expect(event).toMatchObject({ exports: [] });
  });
});

describe('splitLines', () => {
  it('returns complete lines and keeps the partial remainder', () => {
    expect(splitLines('', 'a\nb\nc')).toEqual({ lines: ['a', 'b'], rest: 'c' });
  });

  it('joins a line split across chunks', () => {
    const first = splitLines('', '{"type":"mo');
    expect(first).toEqual({ lines: [], rest: '{"type":"mo' });
    const second = splitLines(first.rest, 'de"}\n');
    expect(second).toEqual({ lines: ['{"type":"mode"}'], rest: '' });
  });

  it('handles CRLF and drops empty lines', () => {
    expect(splitLines('', 'a\r\n\r\nb\r\n')).toEqual({ lines: ['a', 'b'], rest: '' });
  });
});

describe('readChatStream', () => {
  it('delivers events in order, including a line split across chunks', async () => {
    const full = '{"type":"mode","mode":"web"}\n{"type":"mode","mode":"data"}\n{"type":"result","reply":"hi","mode":"data","usedWeb":false,"sources":[]}\n';
    const bytes = enc.encode(full);
    const events = await collect([bytes.slice(0, 10), bytes.slice(10, 45), bytes.slice(45)]);
    expect(events).toEqual([
      { type: 'mode', mode: 'web' },
      { type: 'mode', mode: 'data' },
      { type: 'result', reply: 'hi', mode: 'data', usedWeb: false, sources: [], charts: [], exports: [] },
    ]);
  });

  it('delivers a result event with a populated charts array', async () => {
    const chart = {
      kind: 'donut',
      title: 't',
      unit: 'currency',
      currencySymbol: '₹',
      source: 's',
      slices: [{ label: 'A', value: 1 }],
    };
    const full =
      '{"type":"mode","mode":"data"}\n' +
      `${JSON.stringify({ type: 'result', reply: 'hi', mode: 'data', usedWeb: false, sources: [], charts: [chart] })}\n`;
    const events = await collect([enc.encode(full)]);
    expect(events).toEqual([
      { type: 'mode', mode: 'data' },
      { type: 'result', reply: 'hi', mode: 'data', usedWeb: false, sources: [], charts: [chart], exports: [] },
    ]);
  });

  it('decodes a multi-byte character split across chunks', async () => {
    const line = '{"type":"result","reply":"Price ₹5 café","mode":"data","usedWeb":false,"sources":[]}\n';
    const bytes = enc.encode(line);
    const idx = bytes.indexOf(0xe2); // first byte of the three-byte rupee sign
    const events = await collect([bytes.slice(0, idx + 1), bytes.slice(idx + 1, idx + 2), bytes.slice(idx + 2)]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'result', reply: 'Price ₹5 café' });
  });

  it('handles a final line without a trailing newline', async () => {
    const events = await collect([enc.encode('{"type":"mode","mode":"web"}\n{"type":"error","error":"late"}')]);
    expect(events).toEqual([
      { type: 'mode', mode: 'web' },
      { type: 'error', error: 'late' },
    ]);
  });

  it('skips invalid lines without stopping the stream', async () => {
    const events = await collect([
      enc.encode('garbage\n{"type":"mode","mode":"web"}\n{"type":"unknown"}\n\n{"type":"error","error":"x"}\n'),
    ]);
    expect(events).toEqual([
      { type: 'mode', mode: 'web' },
      { type: 'error', error: 'x' },
    ]);
  });

  it('releases the reader lock when done', async () => {
    const stream = streamOf([enc.encode('{"type":"mode","mode":"data"}\n')]);
    await readChatStream(stream, () => {});
    expect(stream.locked).toBe(false);
  });
});
