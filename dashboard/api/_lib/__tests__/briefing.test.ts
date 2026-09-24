import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BRIEFING_TIMEOUT_MS,
  MAX_ATTEMPTS_PER_DAY,
  MAX_BRIEFING_ITEMS,
  MAX_ITEM_AGE_DAYS,
  buildBriefingPrompt,
  buildVerifiedMap,
  generateBriefing,
  getOrCreateBriefing,
  parseBriefing,
  todayKey,
  type Briefing,
  type BriefingDeps,
  type BriefingKv,
} from '../briefing';
import type { ChatConfig } from '../config';
import type { ResponseLike, ResponsesApi } from '../responsesClient';
import { ALLOWED_DOMAINS, toWebSource, type WebSource } from '../webSources';

const config: ChatConfig = {
  dataModel: 'data-m',
  routerModel: 'router-m',
  webModel: 'web-m',
  webEffort: 'low',
  webSearchEnabled: true,
  routerTimeoutMs: 1000,
  dataTimeoutMs: 1000,
  webTimeoutMs: 1000,
};

const NOW = new Date('2026-09-21T06:00:00Z');
const DATE = '2026-09-21';
const TODAY = { today: DATE };
const URL_A = 'https://www.reuters.com/markets/steel-prices-rise-2026-09-20/';
const URL_B = 'https://www.spglobal.com/commodity-insights/en/news/freight-rates-jump';
const URL_C = 'https://economictimes.indiatimes.com/industry/auto/duty-change/articleshow/1.cms';

function rawItem(over: Record<string, unknown> = {}) {
  return {
    headline: 'Steel prices rise on supply cuts',
    impact: 'cost_up',
    area: 'steel',
    why: 'Higher steel prices raise the cost of stamped body parts.',
    outlet: 'Reuters',
    date: '2026-09-20',
    url: URL_A,
    ...over,
  };
}

function verifiedOf(...urls: string[]): Map<string, WebSource> {
  return buildVerifiedMap(urls.map((u) => toWebSource(u, undefined)!));
}

function modelResponse(items: unknown[], opts: { sources?: string[]; cited?: string[]; usage?: ResponseLike['usage']; searches?: number; status?: string } = {}): ResponseLike {
  const consulted = (opts.sources ?? [URL_A, URL_B, URL_C]).map((url) => ({ url }));
  const searches = opts.searches ?? 2;
  const output: ResponseLike['output'] = [];
  for (let i = 0; i < searches; i++) output.push({ type: 'web_search_call', action: { sources: i === 0 ? consulted : [] } });
  output.push({
    type: 'message',
    content: [
      {
        type: 'output_text',
        text: JSON.stringify({ items }),
        annotations: (opts.cited ?? []).map((url) => ({ type: 'url_citation', url, title: 't' })),
      },
    ],
  });
  return {
    id: 'resp_1',
    status: opts.status,
    output,
    usage: opts.usage ?? { input_tokens: 9000, output_tokens: 700, total_tokens: 9700 },
  };
}

function fakeApi(response: ResponseLike | (() => ResponseLike | Promise<ResponseLike>)) {
  const create = vi.fn(async (_body: Record<string, unknown>, _options?: { timeout?: number }) => (typeof response === 'function' ? response() : response));
  return { api: { create } as unknown as ResponsesApi, create };
}

interface Clock {
  t: number;
}

function fakeKv(initial: Record<string, unknown> = {}, clock: Clock = { t: NOW.getTime() }) {
  const store = new Map<string, unknown>(Object.entries(initial));
  const expiry = new Map<string, number>();
  const sets: { key: string; value: unknown; opts?: { ex?: number; nx?: boolean } }[] = [];
  const alive = (key: string) => {
    const at = expiry.get(key);
    if (at !== undefined && at <= clock.t) {
      store.delete(key);
      expiry.delete(key);
    }
    return store.has(key);
  };
  const kv = {
    get: vi.fn(async (key: string) => (alive(key) ? structuredClone(store.get(key)) : null)),
    set: vi.fn(async (key: string, value: unknown, opts?: { ex?: number; nx?: boolean }) => {
      sets.push({ key, value, opts });
      if (opts?.nx && alive(key)) return null;
      store.set(key, structuredClone(value));
      if (opts?.ex) expiry.set(key, clock.t + opts.ex * 1000);
      else expiry.delete(key);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
      expiry.delete(key);
      return 1;
    }),
    incr: vi.fn(async (key: string) => {
      const next = (alive(key) ? Number(store.get(key)) : 0) + 1;
      store.set(key, next);
      return next;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      expiry.set(key, clock.t + seconds * 1000);
      return 1;
    }),
  } satisfies BriefingKv;
  return { kv, store, sets, clock };
}

function makeDeps(over: Partial<BriefingDeps> & { kv: BriefingKv; api: ResponsesApi }): BriefingDeps {
  return { config, now: () => NOW, timeZone: 'UTC', sleep: async () => {}, ...over };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('todayKey', () => {
  it('uses the calendar date of the given time zone', () => {
    const t = new Date('2026-09-21T20:00:00Z'); // 01:30 on the 22nd in India
    expect(todayKey(t, 'Asia/Kolkata')).toBe('2026-09-22');
    expect(todayKey(t, 'UTC')).toBe('2026-09-21');
  });

  it('switches to the next day exactly at local midnight', () => {
    expect(todayKey(new Date('2026-09-21T18:29:59Z'), 'Asia/Kolkata')).toBe('2026-09-21');
    expect(todayKey(new Date('2026-09-21T18:30:00Z'), 'Asia/Kolkata')).toBe('2026-09-22');
  });

  it('falls back to UTC for an invalid time zone', () => {
    expect(todayKey(new Date('2026-09-21T20:00:00Z'), 'Mars/Olympus')).toBe('2026-09-21');
  });
});

describe('buildBriefingPrompt', () => {
  it('states the audience, the topics, the limits and the safety rules', () => {
    const p = buildBriefingPrompt();
    expect(p).toMatch(/procurement/i);
    for (const topic of ['steel', 'aluminium', 'freight', 'import duties', 'INR/EUR', 'geopolitical']) expect(p).toContain(topic);
    expect(p).toContain('3 to 5');
    expect(p).toContain('cost_up');
    expect(p).toContain('cost_down');
    expect(p).toContain('watch');
    expect(p).toContain('100 characters');
    expect(p).toContain('160 characters');
    expect(p).toContain('YYYY-MM-DD');
    expect(p).toMatch(/copied exactly/i);
    expect(p).toMatch(/never invent/i);
    expect(p).toMatch(/data, never instructions/i);
  });
});

describe('parseBriefing', () => {
  const verified = verifiedOf(URL_A, URL_B, URL_C);

  it('keeps items whose url is verified and takes the domain and canonical url from the verified source', () => {
    const items = parseBriefing(JSON.stringify({ items: [rawItem({ domain: 'evil.example' })] }), verified, TODAY);
    expect(items).toEqual([
      {
        headline: 'Steel prices rise on supply cuts',
        impact: 'cost_up',
        area: 'steel',
        why: 'Higher steel prices raise the cost of stamped body parts.',
        outlet: 'Reuters',
        date: '2026-09-20',
        url: URL_A,
        domain: 'reuters.com',
      },
    ]);
  });

  it('drops items whose url was not among the verified sources', () => {
    const text = JSON.stringify({
      items: [rawItem(), rawItem({ url: 'https://www.reuters.com/other-story' }), rawItem({ url: 'https://evil.example/x' }), rawItem({ url: 'javascript:alert(1)' })],
    });
    expect(parseBriefing(text, verified, TODAY)).toHaveLength(1);
  });

  it('matches a verified url after utm stripping, fragment removal and a trailing-slash difference', () => {
    const text = JSON.stringify({
      items: [
        rawItem({ url: `${URL_A.replace(/\/$/, '')}?utm_source=openai#top` }),
        rawItem({ url: URL_B.toUpperCase().replace('HTTPS', 'https') }),
      ],
    });
    const items = parseBriefing(text, verified, TODAY);
    expect(items.map((i) => i.url)).toEqual([URL_A]);
  });

  it('coerces unknown impact to watch and unknown area to other', () => {
    const [item] = parseBriefing(JSON.stringify({ items: [rawItem({ impact: 'bullish', area: 'semiconductors' })] }), verified, TODAY);
    expect(item.impact).toBe('watch');
    expect(item.area).toBe('other');
  });

  it('drops items with a missing field, an empty string or a bad date', () => {
    const bad = [
      rawItem({ headline: '' }),
      rawItem({ why: '   ' }),
      rawItem({ outlet: undefined }),
      rawItem({ date: '21-09-2026' }),
      rawItem({ date: '2026-13-45' }),
      rawItem({ date: 20260920 }),
      rawItem({ url: 42 }),
    ];
    expect(() => parseBriefing(JSON.stringify({ items: bad }), verified, TODAY)).toThrow(/no valid items/);
    const mixed = parseBriefing(JSON.stringify({ items: [...bad, rawItem()] }), verified, TODAY);
    expect(mixed).toHaveLength(1);
  });

  it('trims the headline to 120 and the why sentence to 180 characters', () => {
    const [item] = parseBriefing(JSON.stringify({ items: [rawItem({ headline: 'h'.repeat(300), why: 'w'.repeat(300) })] }), verified, TODAY);
    expect(item.headline).toHaveLength(120);
    expect(item.why).toHaveLength(180);
  });

  it('keeps at most 5 items and does not repeat a url', () => {
    const many = Array.from({ length: 9 }, (_, i) => rawItem({ url: `https://www.reuters.com/story-${i}` }));
    const v = verifiedOf(...many.map((m) => m.url as string));
    expect(parseBriefing(JSON.stringify({ items: many }), v, TODAY)).toHaveLength(MAX_BRIEFING_ITEMS);
    const dup = parseBriefing(JSON.stringify({ items: [rawItem(), rawItem({ headline: 'Same page again' })] }), verified, TODAY);
    expect(dup).toHaveLength(1);
  });

  it('throws on invalid JSON without echoing the text, and when no item is valid', () => {
    const secret = 'ARTICLE TEXT THAT MUST NOT LEAK';
    expect(() => parseBriefing(`not json ${secret}`, verified, TODAY)).toThrow('briefing output is not valid JSON');
    try {
      parseBriefing(`not json ${secret}`, verified, TODAY);
    } catch (err) {
      expect(String(err)).not.toContain(secret);
    }
    expect(() => parseBriefing(JSON.stringify({ items: [] }), verified, TODAY)).toThrow(/no valid items/);
    expect(() => parseBriefing(JSON.stringify({ nothing: true }), verified, TODAY)).toThrow(/no valid items/);
    expect(() => parseBriefing(JSON.stringify({ items: [rawItem({ url: 'https://evil.example/x' })] }), verified, TODAY)).toThrow(/no valid items/);
  });

  describe('freshness', () => {
    const at = (date: string, n = 0) => rawItem({ date, url: `https://www.reuters.com/fresh-${n}` });
    const v = verifiedOf(...Array.from({ length: 8 }, (_, n) => `https://www.reuters.com/fresh-${n}`));
    const dates = (items: { date: string }[]) => items.map((i) => i.date);

    it('drops an item dated after tomorrow but keeps today and tomorrow (time-zone slack)', () => {
      const text = JSON.stringify({ items: [at('2026-09-23', 0), at('2026-09-22', 1), at('2026-09-21', 2)] });
      expect(dates(parseBriefing(text, v, TODAY))).toEqual(['2026-09-22', '2026-09-21']);
    });

    it('keeps an item exactly MAX_ITEM_AGE_DAYS old and drops one a day older', () => {
      expect(MAX_ITEM_AGE_DAYS).toBe(7);
      const text = JSON.stringify({ items: [at('2026-09-13', 0), at('2026-09-14', 1)] });
      expect(dates(parseBriefing(text, v, TODAY))).toEqual(['2026-09-14']);
    });

    it('does the date arithmetic across month and year boundaries', () => {
      const text = JSON.stringify({ items: [at('2026-02-22', 0), at('2026-02-23', 1), at('2026-03-03', 2), at('2026-03-04', 3)] });
      expect(dates(parseBriefing(text, v, { today: '2026-03-02' }))).toEqual(['2026-03-03', '2026-02-23']);
      const newYear = JSON.stringify({ items: [at('2025-12-25', 0), at('2025-12-26', 1), at('2026-01-02', 2)] });
      expect(dates(parseBriefing(newYear, v, { today: '2026-01-02' }))).toEqual(['2026-01-02', '2025-12-26']);
    });

    it('sorts newest first and keeps the newest five when more than five are valid', () => {
      const text = JSON.stringify({
        items: [at('2026-09-15', 0), at('2026-09-20', 1), at('2026-09-18', 2), at('2026-09-16', 3), at('2026-09-21', 4), at('2026-09-17', 5), at('2026-09-19', 6)],
      });
      expect(dates(parseBriefing(text, v, TODAY))).toEqual(['2026-09-21', '2026-09-20', '2026-09-19', '2026-09-18', '2026-09-17']);
    });

    it('keeps the model order among items with the same date', () => {
      const text = JSON.stringify({ items: [at('2026-09-20', 0), at('2026-09-20', 1)] });
      expect(parseBriefing(text, v, TODAY).map((i) => i.url)).toEqual(['https://www.reuters.com/fresh-0', 'https://www.reuters.com/fresh-1']);
    });

    it('throws like any other no-valid-items case when every item is stale', () => {
      const text = JSON.stringify({ items: [at('2026-09-01', 0), at('2026-08-30', 1), at('2027-01-01', 2)] });
      expect(() => parseBriefing(text, v, TODAY)).toThrow(/no valid items/);
    });
  });

  it('parses leniently: code fences and surrounding prose', () => {
    const json = JSON.stringify({ items: [rawItem()] });
    expect(parseBriefing('```json\n' + json + '\n```', verified, TODAY)).toHaveLength(1);
    expect(parseBriefing(`Here is the briefing:\n${json}\nDone.`, verified, TODAY)).toHaveLength(1);
  });
});

describe('generateBriefing', () => {
  it('sends one request with the forced search tool, allow-list, include, schema and timeout', async () => {
    const t = fakeApi(modelResponse([rawItem()]));
    await generateBriefing({ api: t.api, config, now: () => NOW, timeZone: 'Asia/Kolkata' });

    expect(t.create).toHaveBeenCalledTimes(1);
    const [body, options] = t.create.mock.calls[0] as [Record<string, any>, { timeout: number }];
    expect(options).toEqual({ timeout: BRIEFING_TIMEOUT_MS });
    expect(BRIEFING_TIMEOUT_MS).toBe(50_000);
    expect(body.model).toBe('web-m');
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.instructions).toBe(buildBriefingPrompt());
    expect(body.input).toEqual([
      { role: 'user', content: 'Today is 2026-09-21. Produce the daily impact briefing. Only include items published on or after 2026-09-18; if fewer exist return fewer.' },
    ]);
    expect(body.tools).toEqual([{ type: 'web_search', filters: { allowed_domains: ALLOWED_DOMAINS } }]);
    expect(body.tool_choice).toEqual({ type: 'web_search' });
    expect(body.include).toEqual(['web_search_call.action.sources']);
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'briefing', strict: true });
    const schema = body.text.format.schema;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['items']);
    const item = schema.properties.items.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(['headline', 'impact', 'area', 'why', 'outlet', 'date', 'url']);
    expect(item.properties.impact.enum).toEqual(['cost_up', 'cost_down', 'watch']);
    expect(item.properties.area.enum).toEqual(['steel', 'aluminium', 'freight', 'duty', 'fx', 'geopolitics', 'other']);
  });

  it('omits reasoning when no effort is configured, and uses the time-zone date in the prompt input', async () => {
    const t = fakeApi(modelResponse([rawItem()]));
    await generateBriefing({ api: t.api, config: { ...config, webEffort: undefined }, now: () => new Date('2026-09-21T20:00:00Z'), timeZone: 'Asia/Kolkata' });
    const body = t.create.mock.calls[0][0] as Record<string, any>;
    expect(body.reasoning).toBeUndefined();
    expect(body.input[0].content).toContain('Today is 2026-09-22.');
    expect(body.input[0].content).toContain('on or after 2026-09-19');
  });

  it('returns the briefing with model, date, usage and search count', async () => {
    const t = fakeApi(modelResponse([rawItem(), rawItem({ url: URL_B, area: 'freight', impact: 'watch' })], { searches: 3, usage: { input_tokens: 8000, output_tokens: 500 } }));
    const briefing = await generateBriefing({ api: t.api, config, now: () => NOW, timeZone: 'UTC' });

    expect(briefing).toMatchObject({
      date: DATE,
      generatedAt: NOW.toISOString(),
      model: 'web-m',
      usage: { inputTokens: 8000, outputTokens: 500, totalTokens: 8500, searches: 3 },
    });
    expect(briefing.items.map((i) => i.domain)).toEqual(['reuters.com', 'spglobal.com']);
  });

  it('verifies urls against the cited annotations as well as the search-call sources', async () => {
    const t = fakeApi(modelResponse([rawItem({ url: URL_C })], { sources: [URL_A], cited: [URL_C] }));
    const briefing = await generateBriefing({ api: t.api, config, now: () => NOW, timeZone: 'UTC' });
    expect(briefing.items.map((i) => i.url)).toEqual([URL_C]);
  });

  it('rejects when the model returns only urls the search did not return', async () => {
    const t = fakeApi(modelResponse([rawItem({ url: 'https://www.reuters.com/invented' })]));
    await expect(generateBriefing({ api: t.api, config, now: () => NOW, timeZone: 'UTC' })).rejects.toThrow(/no valid items/);
  });

  it('uses a date passed in by the caller for the prompt, the briefing and the freshness window', async () => {
    let calls = 0;
    // First reading is 23:59 in India on the 21st, later readings are after local midnight.
    const now = () => (calls++ === 0 ? new Date('2026-09-21T18:29:00Z') : new Date('2026-09-21T18:31:00Z'));
    const t = fakeApi(modelResponse([rawItem({ date: '2026-09-21' })]));
    const briefing = await generateBriefing({ api: t.api, config, now, timeZone: 'Asia/Kolkata', date: '2026-09-21' });
    expect(briefing.date).toBe('2026-09-21');
    const body = t.create.mock.calls[0][0] as Record<string, any>;
    expect(body.input[0].content).toContain('Today is 2026-09-21.');
  });

  it('rejects when the response status is failed, and propagates API errors', async () => {
    const failed = fakeApi(modelResponse([rawItem()], { status: 'failed' }));
    await expect(generateBriefing({ api: failed.api, config, now: () => NOW, timeZone: 'UTC' })).rejects.toThrow();
    const boom = fakeApi(() => {
      throw new Error('api down');
    });
    await expect(generateBriefing({ api: boom.api, config, now: () => NOW, timeZone: 'UTC' })).rejects.toThrow('api down');
  });
});

describe('getOrCreateBriefing', () => {
  const KEY = `radar-briefing:${DATE}`;
  const LOCK = `radar-briefing-lock:${DATE}`;
  const FAIL = `radar-briefing-fail:${DATE}`;
  const LATEST = 'radar-briefing-latest';
  const TTL = 3 * 24 * 3600;

  const storedBriefing = (over: Partial<Briefing> = {}): Briefing => ({
    date: DATE,
    generatedAt: '2026-09-21T05:00:00.000Z',
    model: 'web-m',
    items: [{ headline: 'h', impact: 'watch', area: 'other', why: 'w', outlet: 'Reuters', date: '2026-09-20', url: URL_A, domain: 'reuters.com' }],
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, searches: 1 },
    ...over,
  });

  it('is disabled, with no KV traffic and no model call, when web search is off', async () => {
    const { kv } = fakeKv();
    const t = fakeApi(modelResponse([rawItem()]));
    const out = await getOrCreateBriefing(makeDeps({ kv, api: t.api, config: { ...config, webSearchEnabled: false } }));
    expect(out).toEqual({ status: 'disabled' });
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.set).not.toHaveBeenCalled();
    expect(t.create).not.toHaveBeenCalled();
  });

  it('returns the stored briefing without calling the model', async () => {
    const stored = storedBriefing();
    const { kv } = fakeKv({ [KEY]: stored });
    const t = fakeApi(modelResponse([rawItem()]));
    const out = await getOrCreateBriefing(makeDeps({ kv, api: t.api }));
    expect(out).toEqual({ status: 'ready', briefing: stored });
    expect(t.create).not.toHaveBeenCalled();
    expect(kv.set).not.toHaveBeenCalled();
  });

  it('generates on the first call, stores it with a 3 day TTL and records the latest usage', async () => {
    const { kv, store, sets } = fakeKv();
    const t = fakeApi(modelResponse([rawItem()]));
    const out = await getOrCreateBriefing(makeDeps({ kv, api: t.api }));

    expect(out.status).toBe('ready');
    if (out.status !== 'ready') return;
    expect(out.briefing.items).toHaveLength(1);
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(sets[0]).toEqual({ key: LOCK, value: '1', opts: { nx: true, ex: 90 } });
    const stored = sets.find((s) => s.key === KEY);
    expect(stored?.opts).toEqual({ ex: TTL });
    expect(stored?.value).toEqual(out.briefing);
    expect(store.get(LATEST)).toEqual({ totalTokens: 9700, date: DATE, model: 'web-m' });
    expect(sets.find((s) => s.key === FAIL)).toBeUndefined();
  });

  it('a second call the same day serves the stored briefing without another model call', async () => {
    const { kv } = fakeKv();
    const t = fakeApi(modelResponse([rawItem()]));
    const deps = makeDeps({ kv, api: t.api });
    const first = await getOrCreateBriefing(deps);
    const second = await getOrCreateBriefing(deps);
    expect(second).toEqual(first);
    expect(t.create).toHaveBeenCalledTimes(1);
  });

  it('uses the time-zone date for the keys', async () => {
    const { kv, sets } = fakeKv();
    const t = fakeApi(modelResponse([rawItem()]));
    await getOrCreateBriefing(makeDeps({ kv, api: t.api, now: () => new Date('2026-09-21T20:00:00Z'), timeZone: 'Asia/Kolkata' }));
    expect(sets.some((s) => s.key === 'radar-briefing:2026-09-22')).toBe(true);
  });

  it('when another request holds the lock, polls and returns the briefing once it appears', async () => {
    const { kv, store } = fakeKv({ [LOCK]: '1' });
    const t = fakeApi(modelResponse([rawItem()]));
    const sleep = vi.fn(async () => {
      if (sleep.mock.calls.length === 3) store.set(KEY, storedBriefing());
    });
    const out = await getOrCreateBriefing(makeDeps({ kv, api: t.api, sleep }));
    expect(out).toMatchObject({ status: 'ready' });
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(1500);
    expect(t.create).not.toHaveBeenCalled();
  });

  it('when the lock is held and the briefing never appears, gives up after about 20 seconds with pending', async () => {
    const { kv } = fakeKv({ [LOCK]: '1' });
    const t = fakeApi(modelResponse([rawItem()]));
    const sleep = vi.fn(async () => {});
    const out = await getOrCreateBriefing(makeDeps({ kv, api: t.api, sleep }));
    expect(out).toEqual({ status: 'pending' });
    const waited = sleep.mock.calls.length * 1500;
    expect(waited).toBeGreaterThanOrEqual(20_000);
    expect(waited).toBeLessThanOrEqual(22_000);
    expect(t.create).not.toHaveBeenCalled();
  });

  it('a waiting request returns failed as soon as the failure marker appears', async () => {
    const { kv, store } = fakeKv({ [LOCK]: '1' });
    const t = fakeApi(modelResponse([rawItem()]));
    const sleep = vi.fn(async () => {
      if (sleep.mock.calls.length === 2) store.set(FAIL, '1');
    });
    const out = await getOrCreateBriefing(makeDeps({ kv, api: t.api, sleep }));
    expect(out).toEqual({ status: 'failed' });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('a generation error returns failed, sets the 5 minute backoff and frees the lock', async () => {
    const { kv, store, sets } = fakeKv();
    const t = fakeApi(() => {
      throw new Error('api down');
    });
    const out = await getOrCreateBriefing(makeDeps({ kv, api: t.api }));
    expect(out).toEqual({ status: 'failed' });
    expect(sets.find((s) => s.key === FAIL)).toEqual({ key: FAIL, value: '1', opts: { ex: 300 } });
    expect(kv.del).toHaveBeenCalledWith(LOCK);
    expect(store.has(KEY)).toBe(false);
    expect(store.has(LATEST)).toBe(false);
  });

  it('after a failure the next call returns failed without calling the model', async () => {
    const { kv } = fakeKv();
    const t = fakeApi(() => {
      throw new Error('api down');
    });
    const deps = makeDeps({ kv, api: t.api });
    await getOrCreateBriefing(deps);
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(await getOrCreateBriefing(deps)).toEqual({ status: 'failed' });
    expect(t.create).toHaveBeenCalledTimes(1);
  });

  it('a briefing with no verifiable item counts as a failed generation', async () => {
    const { kv, sets } = fakeKv();
    const t = fakeApi(modelResponse([rawItem({ url: 'https://www.reuters.com/invented' })]));
    expect(await getOrCreateBriefing(makeDeps({ kv, api: t.api }))).toEqual({ status: 'failed' });
    expect(sets.some((s) => s.key === FAIL)).toBe(true);
  });

  it('an invalid stored value is ignored and regenerated', async () => {
    const { kv, store } = fakeKv({ [KEY]: { date: DATE, items: 'nope' } });
    const t = fakeApi(modelResponse([rawItem()]));
    const out = await getOrCreateBriefing(makeDeps({ kv, api: t.api }));
    expect(out.status).toBe('ready');
    expect(t.create).toHaveBeenCalledTimes(1);
    expect((store.get(KEY) as Briefing).items).toHaveLength(1);
  });

  it('a stored briefing with an empty or oversized item list is not accepted', async () => {
    for (const bad of [storedBriefing({ items: [] }), storedBriefing({ items: Array.from({ length: 6 }, () => storedBriefing().items[0]) })]) {
      const { kv } = fakeKv({ [KEY]: bad });
      const t = fakeApi(modelResponse([rawItem()]));
      await getOrCreateBriefing(makeDeps({ kv, api: t.api }));
      expect(t.create).toHaveBeenCalledTimes(1);
    }
  });

  it('treats a KV read error as a missing value and still generates', async () => {
    const { kv } = fakeKv();
    let reads = 0;
    kv.get = vi.fn(async () => {
      reads += 1;
      throw new Error('kv read down');
    });
    const t = fakeApi(modelResponse([rawItem()]));
    const out = await getOrCreateBriefing(makeDeps({ kv, api: t.api }));
    expect(out.status).toBe('ready');
    expect(reads).toBeGreaterThan(0);
  });

  it('returns the generated briefing even when storing it fails', async () => {
    const { kv } = fakeKv();
    const realSet = kv.set;
    kv.set = vi.fn(async (key: string, value: unknown, opts?: { ex?: number; nx?: boolean }) => {
      if (opts?.nx) return realSet(key, value, opts);
      throw new Error('kv write down');
    });
    const t = fakeApi(modelResponse([rawItem()]));
    const out = await getOrCreateBriefing(makeDeps({ kv, api: t.api }));
    expect(out.status).toBe('ready');
  });

  it('does not call the model when the lock cannot be taken because KV is down', async () => {
    const { kv } = fakeKv();
    kv.set = vi.fn(async () => {
      throw new Error('kv down');
    });
    const t = fakeApi(modelResponse([rawItem()]));
    expect(await getOrCreateBriefing(makeDeps({ kv, api: t.api }))).toEqual({ status: 'failed' });
    expect(t.create).not.toHaveBeenCalled();
  });

  it('works when the store has no del method', async () => {
    const { kv } = fakeKv();
    const noDel: BriefingKv = { get: kv.get, set: kv.set, incr: kv.incr, expire: kv.expire };
    const t = fakeApi(() => {
      throw new Error('api down');
    });
    expect(await getOrCreateBriefing(makeDeps({ kv: noDel, api: t.api }))).toEqual({ status: 'failed' });
  });

  describe('attempt cap', () => {
    const ATTEMPTS = `radar-briefing-attempts:${DATE}`;
    const BACKOFF_PLUS = 301_000;

    it('allows exactly MAX_ATTEMPTS_PER_DAY model calls across the backoff, then stays failed with no model call', async () => {
      expect(MAX_ATTEMPTS_PER_DAY).toBe(3);
      const clock = { t: NOW.getTime() };
      const { kv, store } = fakeKv({}, clock);
      const t = fakeApi(() => {
        throw new Error('api down');
      });
      const deps = makeDeps({ kv, api: t.api, now: () => new Date(clock.t) });

      for (let attempt = 1; attempt <= 3; attempt++) {
        expect(await getOrCreateBriefing(deps)).toEqual({ status: 'failed' });
        expect(t.create).toHaveBeenCalledTimes(attempt);
        clock.t += BACKOFF_PLUS; // the 5 minute failure marker has expired
      }
      expect(store.get(ATTEMPTS)).toBe(3);

      // The fourth and every later opener of the day gets failed without a model call.
      expect(await getOrCreateBriefing(deps)).toEqual({ status: 'failed' });
      clock.t += BACKOFF_PLUS;
      expect(await getOrCreateBriefing(deps)).toEqual({ status: 'failed' });
      expect(t.create).toHaveBeenCalledTimes(3);
      // The lock is released again so nothing is left held.
      expect(kv.del).toHaveBeenLastCalledWith(LOCK);
    });

    it('increments before the model call and gives the counter a 2 day TTL when it starts', async () => {
      const { kv } = fakeKv();
      const order: string[] = [];
      kv.incr.mockImplementationOnce(async () => {
        order.push('incr');
        return 1;
      });
      const t = fakeApi(() => {
        order.push('model');
        return modelResponse([rawItem()]);
      });
      await getOrCreateBriefing(makeDeps({ kv, api: t.api }));
      expect(order).toEqual(['incr', 'model']);
      expect(kv.incr).toHaveBeenCalledWith(ATTEMPTS);
      expect(kv.expire).toHaveBeenCalledWith(ATTEMPTS, 2 * 24 * 3600);
    });

    it('counts a successful attempt once and later calls never touch the counter', async () => {
      const { kv, store } = fakeKv();
      const t = fakeApi(modelResponse([rawItem()]));
      const deps = makeDeps({ kv, api: t.api });
      expect((await getOrCreateBriefing(deps)).status).toBe('ready');
      expect((await getOrCreateBriefing(deps)).status).toBe('ready');
      expect((await getOrCreateBriefing(deps)).status).toBe('ready');
      expect(kv.incr).toHaveBeenCalledTimes(1);
      expect(store.get(ATTEMPTS)).toBe(1);
      expect(t.create).toHaveBeenCalledTimes(1);
    });

    it('a stored briefing is served even after the cap is used up', async () => {
      const { kv } = fakeKv({ [ATTEMPTS]: 3, [KEY]: storedBriefing() });
      const t = fakeApi(modelResponse([rawItem()]));
      expect((await getOrCreateBriefing(makeDeps({ kv, api: t.api }))).status).toBe('ready');
      expect(kv.incr).not.toHaveBeenCalled();
    });

    it('fails closed when the counter errors: no model call and the lock is released', async () => {
      const { kv } = fakeKv();
      kv.incr.mockRejectedValue(new Error('kv down'));
      const t = fakeApi(modelResponse([rawItem()]));
      expect(await getOrCreateBriefing(makeDeps({ kv, api: t.api }))).toEqual({ status: 'failed' });
      expect(t.create).not.toHaveBeenCalled();
      expect(kv.del).toHaveBeenCalledWith(LOCK);
    });

    it('fails closed when the counter returns something that is not a number', async () => {
      const { kv } = fakeKv();
      kv.incr.mockResolvedValue(null as unknown as number);
      const t = fakeApi(modelResponse([rawItem()]));
      expect(await getOrCreateBriefing(makeDeps({ kv, api: t.api }))).toEqual({ status: 'failed' });
      expect(t.create).not.toHaveBeenCalled();
    });

    it('still generates when only setting the counter TTL fails', async () => {
      const { kv } = fakeKv();
      kv.expire.mockRejectedValue(new Error('kv down'));
      const t = fakeApi(modelResponse([rawItem()]));
      expect((await getOrCreateBriefing(makeDeps({ kv, api: t.api }))).status).toBe('ready');
    });

    it('a briefing with no fresh item counts as a failed attempt', async () => {
      const { kv, store } = fakeKv();
      const t = fakeApi(modelResponse([rawItem({ date: '2026-08-01' })]));
      expect(await getOrCreateBriefing(makeDeps({ kv, api: t.api }))).toEqual({ status: 'failed' });
      expect(store.get(ATTEMPTS)).toBe(1);
      expect(store.has(KEY)).toBe(false);
    });
  });

  it('stores the briefing under the date the run started, even when it finishes after local midnight', async () => {
    const { kv, store } = fakeKv();
    let calls = 0;
    const now = () => (calls++ === 0 ? new Date('2026-09-21T18:29:00Z') : new Date('2026-09-21T18:31:00Z'));
    const t = fakeApi(modelResponse([rawItem({ date: '2026-09-21' })]));
    const out = await getOrCreateBriefing(makeDeps({ kv, api: t.api, now, timeZone: 'Asia/Kolkata' }));
    expect(out.status).toBe('ready');
    if (out.status === 'ready') expect(out.briefing.date).toBe('2026-09-21');
    expect(store.has('radar-briefing:2026-09-21')).toBe(true);
    expect(store.has('radar-briefing:2026-09-22')).toBe(false);
  });

  it('logs only the error name and HTTP status of provider errors, never their message', async () => {
    const error = vi.spyOn(console, 'error');
    const { kv } = fakeKv();
    const providerError = Object.assign(new Error('PROVIDER SAID: SECRET ARTICLE TEXT'), { name: 'BadRequestError', status: 400 });
    const t = fakeApi(() => {
      throw providerError;
    });
    expect(await getOrCreateBriefing(makeDeps({ kv, api: t.api }))).toEqual({ status: 'failed' });
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain('SECRET ARTICLE TEXT');
    expect(logged).toContain('BadRequestError');
    expect(logged).toContain('400');
    expect(error.mock.calls.flat().some((a) => a instanceof Error)).toBe(false);
  });

  it('logs no article text or user content on success or failure', async () => {
    const info = vi.spyOn(console, 'info');
    const error = vi.spyOn(console, 'error');
    const { kv } = fakeKv();
    await getOrCreateBriefing(makeDeps({ kv, api: fakeApi(modelResponse([rawItem()])).api }));
    const { kv: kv2 } = fakeKv();
    await getOrCreateBriefing(makeDeps({ kv: kv2, api: fakeApi(modelResponse([rawItem({ url: 'https://www.reuters.com/invented' })])).api }));
    const logged = JSON.stringify([...info.mock.calls, ...error.mock.calls]);
    expect(logged).not.toContain('Steel prices rise');
    expect(logged).not.toContain('stamped body parts');
    expect(logged).not.toContain(URL_A);
  });
});
