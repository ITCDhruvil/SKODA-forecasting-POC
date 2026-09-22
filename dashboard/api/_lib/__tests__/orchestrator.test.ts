import { describe, it, expect, vi, beforeEach } from 'vitest';
import { answer, LIMIT_NOTE, NO_SEARCH_NOTE, RECORD_USAGE_GRACE_MS, UNREACHABLE_NOTE, type OrchestratorDeps } from '../orchestrator';
import type { ChatConfig } from '../config';
import type { ResponseLike, ResponsesApi } from '../responsesClient';
import type { Mode } from '../router';
import { ALLOWED_DOMAINS } from '../webSources';

const config: ChatConfig = {
  dataModel: 'data-m',
  routerModel: 'router-m',
  webModel: 'web-m',
  webSearchEnabled: true,
  routerTimeoutMs: 1000,
  dataTimeoutMs: 1000,
  webTimeoutMs: 1000,
};

const text = (t: string): ResponseLike => ({
  id: 'r',
  output: [{ type: 'message', content: [{ type: 'output_text', text: t, annotations: [] }] }],
});
const route = (mode: string): ResponseLike => text(JSON.stringify({ mode }));

type Body = Record<string, any>;

function setup(opts: {
  router?: (b: Body) => ResponseLike | Promise<ResponseLike>;
  main?: (b: Body) => ResponseLike | Promise<ResponseLike>;
  budget?: { allowed: boolean };
  config?: Partial<ChatConfig>;
  now?: () => number;
  onMode?: (mode: Mode) => void;
  recordUsage?: (kind: Mode, tokens: number) => void | Promise<void>;
}) {
  const create = vi.fn(async (body: Body, _options?: { timeout?: number }) => {
    const isRouter = body.text?.format?.name === 'route';
    return isRouter ? opts.router!(body) : opts.main!(body);
  });
  const checkBudget = vi.fn().mockResolvedValue(opts.budget ?? { allowed: true });
  const deps: OrchestratorDeps = {
    api: { create } as ResponsesApi,
    config: { ...config, ...opts.config },
    checkBudget,
    now: opts.now,
    onMode: opts.onMode,
    recordUsage: opts.recordUsage,
  };
  const mainCalls = () => create.mock.calls.filter((c) => c[0].text?.format?.name !== 'route').map((c) => c[0] as Body);
  const toolNames = (b: Body) => (b.tools ?? []).map((t: Body) => t.name ?? t.type);
  return { deps, create, checkBudget, mainCalls, toolNames };
}

const ask = (content: string, extra: Partial<{ webEnabled: boolean }> = {}) => ({
  messages: [{ role: 'user' as const, content }],
  webEnabled: extra.webEnabled ?? true,
  ip: '1.2.3.4',
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('answer', () => {
  it('data mode: no web tool, no write tools, no sources', async () => {
    const t = setup({ router: () => route('data'), main: () => text('the answer') });
    const result = await answer(ask('Which parts moved most?'), t.deps);

    expect(result).toEqual({ reply: 'the answer', mode: 'data', usedWeb: false, sources: [] });
    const names = t.toolNames(t.mainCalls()[0]);
    expect(names).not.toContain('web_search');
    expect(names).not.toContain('confirmGeoAlert');
    expect(t.checkBudget).not.toHaveBeenCalled();
    expect(t.mainCalls()[0].model).toBe('data-m');
  });

  it('web mode: offers filtered web search, no write tools, returns cited sources', async () => {
    const cited: ResponseLike = {
      id: 'r',
      output: [
        { type: 'web_search_call' },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'Steel is up (Reuters, 12 Sep 2026).',
              annotations: [{ type: 'url_citation', url: 'https://www.reuters.com/a?utm_source=openai', title: 'Steel' }],
            },
          ],
        },
      ],
    };
    const t = setup({ router: () => route('web'), main: () => cited });
    const result = await answer(ask('Any news on steel tariffs?'), t.deps);

    expect(result.mode).toBe('web');
    expect(result.usedWeb).toBe(true);
    expect(result.sources).toEqual([{ title: 'Steel', url: 'https://www.reuters.com/a', domain: 'reuters.com' }]);
    const body = t.mainCalls()[0];
    expect(body.model).toBe('web-m');
    expect(body.tools).toContainEqual({ type: 'web_search', filters: { allowed_domains: ALLOWED_DOMAINS } });
    const names = t.toolNames(body);
    expect(names).not.toContain('confirmGeoAlert');
    expect(names).not.toContain('dismissGeoAlert');
    expect(t.checkBudget).toHaveBeenCalledWith('1.2.3.4');
  });

  it('forces the web search on the first web-mode call, and never in data mode', async () => {
    const web = setup({ router: () => route('web'), main: () => text('x') });
    await answer(ask('Any news on steel tariffs?'), web.deps);
    expect(web.mainCalls()[0].tool_choice).toEqual({ type: 'web_search' });

    const data = setup({ router: () => route('data'), main: () => text('x') });
    await answer(ask('Which parts moved most?'), data.deps);
    expect(data.mainCalls()[0].tool_choice).toBeUndefined();
  });

  it('web mode: searches that produced no allow-listed source do not claim usedWeb', async () => {
    const uncited: ResponseLike = {
      id: 'r',
      output: [
        { type: 'web_search_call' },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'I could not verify this.',
              annotations: [{ type: 'url_citation', url: 'https://example.com/blog', title: 'Blog' }],
            },
          ],
        },
      ],
    };
    const t = setup({ router: () => route('web'), main: () => uncited });
    const result = await answer(ask('Any news on steel tariffs?'), t.deps);
    expect(result).toEqual({ reply: 'I could not verify this.', mode: 'web', usedWeb: false, sources: [] });

    const noAnnotations: ResponseLike = {
      id: 'r',
      output: [{ type: 'web_search_call' }, ...text('Nothing found.').output],
    };
    const t2 = setup({ router: () => route('web'), main: () => noAnnotations });
    expect(await answer(ask('Any news on steel tariffs?'), t2.deps)).toEqual({
      reply: 'Nothing found.',
      mode: 'web',
      usedWeb: false,
      sources: [],
    });
  });

  it('web mode: a forced search that shares a response with a tool call still yields sources and usedWeb when the final answer has no annotations', async () => {
    const t = setup({
      router: () => route('web'),
      main: (b) =>
        b.previous_response_id
          ? text('News and dashboard numbers combined.')
          : {
              id: 'r1',
              output: [
                {
                  type: 'web_search_call',
                  action: { sources: [{ url: 'https://www.spglobal.com/commodity/red-sea-freight-rates?utm_source=openai' }] },
                },
                { type: 'function_call', call_id: 'c1', name: 'getKpis', arguments: '{}' },
              ],
            },
    });
    const result = await answer(ask('Red Sea: what does our model say and is there new news?'), t.deps);

    expect(t.mainCalls()).toHaveLength(2);
    expect(t.mainCalls()[0].tool_choice).toEqual({ type: 'web_search' });
    expect(t.mainCalls()[1].tool_choice).toBeUndefined();
    expect(result.mode).toBe('web');
    expect(result.usedWeb).toBe(true);
    expect(result.sources).toEqual([
      { title: 'red sea freight rates', url: 'https://www.spglobal.com/commodity/red-sea-freight-rates', domain: 'spglobal.com' },
    ]);
    expect(result.reply).toBe('News and dashboard numbers combined.');
  });

  it('web mode that ran no search says so and reports no web use', async () => {
    const t = setup({ router: () => route('web'), main: () => text('Alerts show two pending items.') });
    const result = await answer(ask('Anything I should be worried about this week?'), t.deps);

    expect(result).toEqual({
      reply: `Alerts show two pending items.\n\n${NO_SEARCH_NOTE}`,
      mode: 'web',
      usedWeb: false,
      sources: [],
    });
  });

  it('web budget exhausted: answers in data mode with a note and no web tool', async () => {
    const t = setup({ router: () => route('web'), main: () => text('dashboard answer'), budget: { allowed: false } });
    const result = await answer(ask('Any news?'), t.deps);

    expect(result.mode).toBe('data');
    expect(result.usedWeb).toBe(false);
    expect(result.reply).toBe(`dashboard answer\n\n${LIMIT_NOTE}`);
    expect(t.toolNames(t.mainCalls()[0])).not.toContain('web_search');
  });

  it('web failure: falls back to data mode with a note', async () => {
    const t = setup({
      router: () => route('web'),
      main: (b) => {
        if ((b.tools ?? []).some((x: Body) => x.type === 'web_search')) throw new Error('search down');
        return text('dashboard answer');
      },
    });
    const result = await answer(ask('Any news?'), t.deps);

    expect(result).toMatchObject({ mode: 'data', usedWeb: false, reply: `dashboard answer\n\n${UNREACHABLE_NOTE}` });
  });

  it('web failure with almost no time left: does not attempt the fallback', async () => {
    let clock = 0;
    const t = setup({
      router: () => route('web'),
      main: () => {
        clock = 50_000;
        throw new Error('search down');
      },
      now: () => clock,
    });
    await expect(answer(ask('Any news?'), t.deps)).rejects.toThrow('search down');
    expect(t.mainCalls()).toHaveLength(1);
  });

  it('a data-mode failure is not retried and propagates', async () => {
    const t = setup({ router: () => route('data'), main: () => { throw new Error('boom'); } });
    await expect(answer(ask('hi'), t.deps)).rejects.toThrow('boom');
  });

  it('web off from the client: the router is not called at all, budget untouched', async () => {
    const t = setup({ router: () => { throw new Error('router must not run'); }, main: () => text('ok') });
    const result = await answer(ask('Any news?', { webEnabled: false }), t.deps);

    expect(t.create).toHaveBeenCalledTimes(1);
    expect(t.mainCalls()).toHaveLength(1);
    expect(result.mode).toBe('data');
    expect(t.checkBudget).not.toHaveBeenCalled();
  });

  it('web off on the server: same as off from the client', async () => {
    const t = setup({
      router: () => { throw new Error('router must not run'); },
      main: () => text('ok'),
      config: { webSearchEnabled: false },
    });
    const result = await answer(ask('Any news?'), t.deps);
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(result.mode).toBe('data');
    expect(t.checkBudget).not.toHaveBeenCalled();
  });

  it('web off does not block a clear alert action, which still skips the router', async () => {
    const t = setup({ router: () => { throw new Error('router must not run'); }, main: () => text('done') });
    const result = await answer(ask('Confirm the Red Sea alert', { webEnabled: false }), t.deps);
    expect(result.mode).toBe('action');
    expect(t.create).toHaveBeenCalledTimes(1);
  });

  it('the router model choosing "action" degrades to data mode with no write tools', async () => {
    const t = setup({ router: () => route('action'), main: () => text('ok') });
    const result = await answer(ask('Anything on the Red Sea?'), t.deps);
    expect(result.mode).toBe('data');
    expect(t.toolNames(t.mainCalls()[0])).not.toContain('confirmGeoAlert');
  });

  it('a clear alert action skips the router and gets only alert tools', async () => {
    const t = setup({ router: () => { throw new Error('router must not run'); }, main: () => text('done') });
    const result = await answer(ask('Confirm the Red Sea alert'), t.deps);

    expect(result.mode).toBe('action');
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(t.toolNames(t.mainCalls()[0]).sort()).toEqual(['confirmGeoAlert', 'dismissGeoAlert', 'getGeoHitlAlerts']);
  });

  it('router failure falls back to data mode', async () => {
    const t = setup({ router: () => { throw new Error('router down'); }, main: () => text('ok') });
    expect((await answer(ask('anything'), t.deps)).mode).toBe('data');
  });

  it('the router sees only the latest user message and a stub of the last reply', async () => {
    const t = setup({ router: () => route('data'), main: () => text('ok') });
    await answer(
      {
        messages: [
          { role: 'user', content: 'first secret question' },
          { role: 'assistant', content: 'previous answer text' },
          { role: 'user', content: 'latest question' },
        ],
        webEnabled: true,
        ip: '1.2.3.4',
      },
      t.deps,
    );
    const content: string = (t.create.mock.calls[0][0] as Body).input[0].content;
    expect(content).toContain('latest question');
    expect(content).toContain('previous answer text');
    expect(content).not.toContain('first secret question');
  });

  it('clamps every OpenAI call timeout to what is left of the 55s total budget', async () => {
    let clock = 0;
    const t = setup({
      router: () => {
        clock = 40_000; // the router ate 40s
        return route('data');
      },
      main: () => text('ok'),
      config: { dataTimeoutMs: 100_000 },
      now: () => clock,
    });
    await answer(ask('hi'), t.deps);

    const mainCall = t.create.mock.calls.find((c) => c[0].text?.format?.name !== 'route');
    expect(mainCall?.[1]).toEqual({ timeout: 15_000 });
  });

  it('a later call in the tool loop cannot start once the 55s total budget is spent', async () => {
    let clock = 0;
    const t = setup({
      router: () => route('data'),
      main: () => {
        clock = 54_500; // the first main call ran long and asked for a tool
        return { id: 'r1', output: [{ type: 'function_call', call_id: 'c1', name: 'noSuchTool', arguments: '{}' }] };
      },
      now: () => clock,
    });
    await expect(answer(ask('hi'), t.deps)).rejects.toThrow('chat deadline exceeded');
    expect(t.mainCalls()).toHaveLength(1);
  });

  it('logs mode and latency but never message content', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    info.mockClear(); // the spy from beforeEach is shared, so drop calls from earlier tests
    const t = setup({ router: () => route('data'), main: () => text('the reply') });
    await answer(ask('a very private question'), t.deps);
    const logged = info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('"mode":"data"');
    expect(logged).not.toContain('a very private question');
    expect(logged).not.toContain('the reply');
  });
});

describe('answer onMode', () => {
  it('reports data once for a data route', async () => {
    const onMode = vi.fn();
    const t = setup({ router: () => route('data'), main: () => text('ok'), onMode });
    await answer(ask('Which parts moved most?'), t.deps);
    expect(onMode.mock.calls).toEqual([['data']]);
  });

  it('reports web once for a web route with budget available', async () => {
    const onMode = vi.fn();
    const t = setup({ router: () => route('web'), main: () => text('ok'), onMode });
    await answer(ask('Any news on steel tariffs?'), t.deps);
    expect(onMode.mock.calls).toEqual([['web']]);
  });

  it('reports data once when the web budget is denied', async () => {
    const onMode = vi.fn();
    const t = setup({ router: () => route('web'), main: () => text('ok'), budget: { allowed: false }, onMode });
    await answer(ask('Any news?'), t.deps);
    expect(onMode.mock.calls).toEqual([['data']]);
  });

  it('reports web then data when web mode fails and falls back', async () => {
    const onMode = vi.fn();
    const t = setup({
      router: () => route('web'),
      main: (b) => {
        if ((b.tools ?? []).some((x: Body) => x.type === 'web_search')) throw new Error('search down');
        return text('dashboard answer');
      },
      onMode,
    });
    await answer(ask('Any news?'), t.deps);
    expect(onMode.mock.calls).toEqual([['web'], ['data']]);
  });

  it('reports action once for a forced action, without calling the router', async () => {
    const onMode = vi.fn();
    const t = setup({ router: () => { throw new Error('router must not run'); }, main: () => text('done'), onMode });
    await answer(ask('Confirm the Red Sea alert'), t.deps);
    expect(onMode.mock.calls).toEqual([['action']]);
  });

  it('an onMode that throws does not change the result', async () => {
    const onMode = vi.fn(() => {
      throw new Error('client gone');
    });
    const t = setup({ router: () => route('data'), main: () => text('the answer'), onMode });
    const result = await answer(ask('Which parts moved most?'), t.deps);
    expect(result).toEqual({ reply: 'the answer', mode: 'data', usedWeb: false, sources: [] });
    expect(onMode).toHaveBeenCalledTimes(1);
  });

  it('calls onMode before the main model call', async () => {
    const order: string[] = [];
    const t = setup({
      router: () => route('web'),
      main: () => {
        order.push('main');
        return text('ok');
      },
      onMode: (m) => order.push(`mode:${m}`),
    });
    await answer(ask('Any news on steel tariffs?'), t.deps);
    expect(order).toEqual(['mode:web', 'main']);
  });
});

describe('recordUsage', () => {
  const withUsage = (t: string, total: number): ResponseLike => ({ ...text(t), usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total } });
  const isWebCall = (b: Body) => (b.tools ?? []).some((x: Body) => x.type === 'web_search');

  it('reports the tokens of a data answer once, with the data mode', async () => {
    const record = vi.fn();
    const t = setup({ router: () => route('data'), main: () => withUsage('the answer', 1234), recordUsage: record });
    await answer(ask('Which parts moved most?'), t.deps);
    expect(record.mock.calls).toEqual([['data', 1234]]);
  });

  it('sums every model call of the run and does not count the router', async () => {
    const record = vi.fn();
    let n = 0;
    const t = setup({
      router: () => ({ ...route('data'), usage: { total_tokens: 777 } }),
      main: () => {
        n += 1;
        if (n === 1) {
          return { id: 'r1', output: [{ type: 'function_call', call_id: 'c1', name: 'getKpis', arguments: '{}' }], usage: { total_tokens: 300 } };
        }
        return withUsage('done', 200);
      },
      recordUsage: record,
    });
    await answer(ask('Which parts moved most?'), t.deps);
    expect(record.mock.calls).toEqual([['data', 500]]);
  });

  it('reports a web answer under web', async () => {
    const record = vi.fn();
    const t = setup({
      router: () => route('web'),
      main: () => ({ ...withUsage('news', 900), output: [{ type: 'web_search_call' }, ...withUsage('news', 900).output] }),
      recordUsage: record,
    });
    await answer(ask('Any news?'), t.deps);
    expect(record.mock.calls).toEqual([['web', 900]]);
  });

  it('a web failure with a data fallback sums both runs and reports data', async () => {
    const record = vi.fn();
    let webCalls = 0;
    const t = setup({
      router: () => route('web'),
      main: (b) => {
        if (isWebCall(b)) {
          webCalls += 1;
          if (webCalls === 1) {
            return { id: 'w1', output: [{ type: 'function_call', call_id: 'c1', name: 'getKpis', arguments: '{}' }], usage: { total_tokens: 700 } };
          }
          throw new Error('search down');
        }
        return withUsage('dashboard answer', 400);
      },
      recordUsage: record,
    });
    const result = await answer(ask('Any news?'), t.deps);
    expect(result.mode).toBe('data');
    expect(record.mock.calls).toEqual([['data', 1100]]);
  });

  it('is not called when the answer throws', async () => {
    const record = vi.fn();
    const t = setup({ router: () => route('data'), main: () => { throw new Error('boom'); }, recordUsage: record });
    await expect(answer(ask('hi'), t.deps)).rejects.toThrow('boom');
    expect(record).not.toHaveBeenCalled();
  });

  it('a recordUsage that throws or rejects does not break the answer', async () => {
    const thrower = vi.fn(() => {
      throw new Error('kv down');
    });
    const t1 = setup({ router: () => route('data'), main: () => withUsage('the answer', 50), recordUsage: thrower });
    expect(await answer(ask('hi'), t1.deps)).toEqual({ reply: 'the answer', mode: 'data', usedWeb: false, sources: [] });
    const rejecter = vi.fn().mockRejectedValue(new Error('kv down'));
    const t2 = setup({ router: () => route('data'), main: () => withUsage('the answer', 50), recordUsage: rejecter });
    expect(await answer(ask('hi'), t2.deps)).toEqual({ reply: 'the answer', mode: 'data', usedWeb: false, sources: [] });
    expect(thrower).toHaveBeenCalledTimes(1);
    expect(rejecter).toHaveBeenCalledTimes(1);
  });

  it('a hanging recordUsage is not awaited past a short grace period', async () => {
    vi.useFakeTimers();
    try {
      const t = setup({ router: () => route('data'), main: () => withUsage('the answer', 50), recordUsage: () => new Promise<void>(() => {}) });
      const pending = answer(ask('hi'), t.deps);
      await vi.advanceTimersByTimeAsync(RECORD_USAGE_GRACE_MS + 100);
      expect((await pending).reply).toBe('the answer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('works without a recordUsage dependency', async () => {
    const t = setup({ router: () => route('data'), main: () => withUsage('the answer', 50) });
    expect((await answer(ask('hi'), t.deps)).reply).toBe('the answer');
  });
});
