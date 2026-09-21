import { describe, it, expect, vi } from 'vitest';
import {
  ResponsesChatClient,
  extractOutputText,
  stripTrackingParams,
  toInputItems,
  type ResponseLike,
  type ResponseOutputItem,
  type ResponsesApi,
} from '../responsesClient';
import type { ChatMessage } from '../chatLoop';
import type { ToolDefinition } from '../tools';

const TOOL: ToolDefinition = {
  type: 'function',
  function: { name: 'getKpis', description: 'kpis', parameters: { type: 'object', properties: {} } },
};

function textResponse(text: string, id = 'resp_1'): ResponseLike {
  return { id, output: [{ type: 'message', content: [{ type: 'output_text', text, annotations: [] }] }] };
}

function fakeApi(...responses: ResponseLike[]) {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  const api: ResponsesApi = { create };
  return { api, create };
}

const base: ChatMessage[] = [
  { role: 'system', content: 'SYS' },
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'yo' },
  { role: 'user', content: 'again' },
];

describe('ResponsesChatClient', () => {
  it('sends system text as instructions and history as input on the first call', async () => {
    const { api, create } = fakeApi(textResponse('hello'));
    const client = new ResponsesChatClient({ api, model: 'm', tools: [TOOL], timeoutMs: 1000 });

    const out = await client.createCompletion(base);

    expect(out).toEqual({ content: 'hello', toolCalls: [] });
    const body = create.mock.calls[0][0];
    expect(body.model).toBe('m');
    expect(body.instructions).toBe('SYS');
    expect(body.input).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
      { role: 'user', content: 'again' },
    ]);
    expect(body.tools).toEqual([
      { type: 'function', name: 'getKpis', description: 'kpis', parameters: { type: 'object', properties: {} }, strict: false },
    ]);
    expect(body.previous_response_id).toBeUndefined();
    expect(create.mock.calls[0][1]).toEqual({ timeout: 1000 });
  });

  it('maps function_call output items to tool calls and ignores reasoning items', async () => {
    const { api } = fakeApi({
      id: 'r1',
      output: [{ type: 'reasoning' }, { type: 'function_call', call_id: 'c1', name: 'getKpis', arguments: '{}' }],
    });
    const client = new ResponsesChatClient({ api, model: 'm', tools: [TOOL], timeoutMs: 1000 });

    const out = await client.createCompletion(base);

    expect(out.content).toBeNull();
    expect(out.toolCalls).toEqual([{ id: 'c1', name: 'getKpis', arguments: '{}' }]);
  });

  it('on a follow-up call sends only tool outputs with previous_response_id and resends instructions and tools', async () => {
    const { api, create } = fakeApi(
      { id: 'r1', output: [{ type: 'function_call', call_id: 'c1', name: 'getKpis', arguments: '{}' }] },
      textResponse('done', 'r2'),
    );
    const client = new ResponsesChatClient({ api, model: 'm', tools: [TOOL], timeoutMs: 1000 });

    await client.createCompletion(base);
    const next: ChatMessage[] = [
      ...base,
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'getKpis', arguments: '{}' }] },
      { role: 'tool', tool_call_id: 'c1', name: 'getKpis', content: '{"a":1}' },
    ];
    await client.createCompletion(next);

    const body2 = create.mock.calls[1][0];
    expect(body2.previous_response_id).toBe('r1');
    expect(body2.input).toEqual([{ type: 'function_call_output', call_id: 'c1', output: '{"a":1}' }]);
    expect(body2.instructions).toBe('SYS');
    expect(body2.tools).toHaveLength(1);
  });

  it('forwards reasoning effort when configured and omits it otherwise', async () => {
    const { api, create } = fakeApi(textResponse('a'), textResponse('b'));
    await new ResponsesChatClient({ api, model: 'm', tools: [TOOL], timeoutMs: 1, reasoningEffort: 'low' }).createCompletion(base);
    await new ResponsesChatClient({ api, model: 'm', tools: [TOOL], timeoutMs: 1 }).createCompletion(base);
    expect(create.mock.calls[0][0].reasoning).toEqual({ effort: 'low' });
    expect(create.mock.calls[1][0].reasoning).toBeUndefined();
  });

  it('without a deadline the per-call timeout is exactly timeoutMs', async () => {
    const { api, create } = fakeApi(textResponse('a'), textResponse('b', 'r2'));
    const client = new ResponsesChatClient({ api, model: 'm', tools: [TOOL], timeoutMs: 25_000, now: () => 999_999 });
    await client.createCompletion(base);
    await client.createCompletion(base);
    expect(create.mock.calls[0][1]).toEqual({ timeout: 25_000 });
    expect(create.mock.calls[1][1]).toEqual({ timeout: 25_000 });
  });

  it('clamps each call timeout to the time left before the deadline', async () => {
    const { api, create } = fakeApi(textResponse('a'), textResponse('b', 'r2'), textResponse('c', 'r3'));
    let clock = 0;
    const client = new ResponsesChatClient({
      api,
      model: 'm',
      tools: [TOOL],
      timeoutMs: 25_000,
      deadline: 30_000,
      now: () => clock,
    });
    await client.createCompletion(base); // 30_000 left, cap 25_000 wins
    clock = 20_000;
    await client.createCompletion(base); // 10_000 left
    clock = 29_500;
    await expect(client.createCompletion(base)).rejects.toThrow('chat deadline exceeded'); // 500 left
    expect(create.mock.calls[0][1]).toEqual({ timeout: 25_000 });
    expect(create.mock.calls[1][1]).toEqual({ timeout: 10_000 });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('with under a second left it throws and does not call the API', async () => {
    const { api, create } = fakeApi(textResponse('never'));
    const client = new ResponsesChatClient({
      api,
      model: 'm',
      tools: [TOOL],
      timeoutMs: 25_000,
      deadline: 10_000,
      now: () => 9_001,
    });
    await expect(client.createCompletion(base)).rejects.toThrow('chat deadline exceeded');
    expect(create).not.toHaveBeenCalled();
  });

  it('throws when the API reports a failed response', async () => {
    const { api } = fakeApi({ id: 'r1', status: 'failed', output: [] });
    const client = new ResponsesChatClient({ api, model: 'm', tools: [TOOL], timeoutMs: 1 });
    await expect(client.createCompletion(base)).rejects.toThrow('failed');
  });
});

describe('extractOutputText', () => {
  it('joins every output_text part across message items', () => {
    const res: ResponseLike = {
      id: 'r',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'c' }] },
      ],
    };
    expect(extractOutputText(res)).toBe('abc');
  });

  describe('citation markers', () => {
    // The Responses API wraps citation anchors in private-use characters:
    // U+E200 (start) "cite" U+E202 (separator) id ... U+E201 (end).
    const open = '';
    const sep = '';
    const close = '';
    const marker = (...ids: string[]) => `${open}cite${sep}${ids.join(sep)}${close}`;
    const only = (t: string) => extractOutputText(textResponse(t));

    it('removes a marker and collapses the double space it leaves', () => {
      expect(only(`Steel is up ${marker('turn0search0')} again.`)).toBe('Steel is up again.');
    });

    it('removes several markers and markers with several separated ids', () => {
      expect(only(`A ${marker('turn0search0')} and B ${marker('turn0search1', 'turn0search2')} both rose.`)).toBe(
        'A and B both rose.',
      );
    });

    it('removes the space before punctuation that a marker leaves behind', () => {
      expect(only(`Prices rose ${marker('turn0search0')}. Then fell ${marker('turn0search1')}, again.`)).toBe(
        'Prices rose. Then fell, again.',
      );
    });

    it('returns plain text, markdown links and non-BMP emoji byte-identical', () => {
      const plain = 'Copper  rose 3 % .  See [Reuters](https://www.reuters.com/a) \u{1F600} for more, ok?';
      expect(only(plain)).toBe(plain);
    });

    it('removes stray private-use characters outside a well-formed pair', () => {
      expect(only(`Up ${open} down.`)).toBe('Up down.');
      expect(only(`Up ${sep} down.`)).toBe('Up down.');
      expect(only(`Up ${close} down.`)).toBe('Up down.');
      expect(only('a\uE2FFb\uE250c')).toBe('abc');
    });

    it('leaves private-use characters just outside U+E200-U+E2FF untouched, double spaces included', () => {
      for (const ch of ['\uE000', '\uE1FF', '\uE300', '\uF8FF']) {
        const text = `Apple  ${ch} logo , here.`;
        expect(only(text)).toBe(text);
      }
    });

    it('an unclosed start marker does not swallow text up to the next marker', () => {
      expect(only(`A ${open} unclosed text here and B ${marker('turn0search0')} done.`)).toBe(
        'A unclosed text here and B done.',
      );
    });

    it('leaves a router JSON payload unchanged', () => {
      expect(only('{"mode":"web"}')).toBe('{"mode":"web"}');
    });

    it('strips markers from the text ResponsesChatClient returns', async () => {
      const { api } = fakeApi(textResponse(`Steel is up ${marker('turn0search0')} again.`));
      const client = new ResponsesChatClient({ api, model: 'm', tools: [], timeoutMs: 1000 });
      expect((await client.createCompletion(base)).content).toBe('Steel is up again.');
    });
  });
});

describe('stripTrackingParams', () => {
  it('removes utm_source=openai when it is the only query parameter', () => {
    expect(stripTrackingParams('([reuters.com](https://www.reuters.com/a/b?utm_source=openai))')).toBe(
      '([reuters.com](https://www.reuters.com/a/b))',
    );
  });

  it('keeps other parameters whether utm_source=openai comes first or last', () => {
    expect(stripTrackingParams('https://x.com/a?utm_source=openai&id=5')).toBe('https://x.com/a?id=5');
    expect(stripTrackingParams('https://x.com/a?id=5&utm_source=openai')).toBe('https://x.com/a?id=5');
  });

  it('removes every occurrence in the text', () => {
    expect(stripTrackingParams('[a](https://a.com/1?utm_source=openai) and [b](https://b.com/2?utm_source=openai)')).toBe(
      '[a](https://a.com/1) and [b](https://b.com/2)',
    );
  });

  it('returns text without the parameter byte-identical, double spaces included', () => {
    const plain = 'Copper  rose.  See [Reuters](https://www.reuters.com/a?id=1) for more .';
    expect(stripTrackingParams(plain)).toBe(plain);
  });

  it('leaves other utm parameters and other utm_source values alone', () => {
    expect(stripTrackingParams('https://x.com/a?utm_medium=email')).toBe('https://x.com/a?utm_medium=email');
    expect(stripTrackingParams('https://x.com/a?utm_source=newsletter')).toBe('https://x.com/a?utm_source=newsletter');
    expect(stripTrackingParams('https://x.com/a?utm_source=openai_x')).toBe('https://x.com/a?utm_source=openai_x');
    expect(stripTrackingParams('https://x.com/a?utm_source=openai_x&id=5')).toBe('https://x.com/a?utm_source=openai_x&id=5');
  });

  it('is applied by extractOutputText, which still collapses whitespace only when a citation marker was removed', () => {
    const only = (t: string) => extractOutputText(textResponse(t));
    expect(only('See ([reuters.com](https://www.reuters.com/a?utm_source=openai)).')).toBe(
      'See ([reuters.com](https://www.reuters.com/a)).',
    );
    expect(only('Two  spaces ([r](https://r.com/a?utm_source=openai)).')).toBe('Two  spaces ([r](https://r.com/a)).');
    expect(only('A \uE200cite\uE202t0\uE201 b  ([r](https://r.com/a?utm_source=openai)).')).toBe('A b ([r](https://r.com/a)).');
  });
});

describe('toInputItems', () => {
  it('replays an assistant tool-call turn and its tool result', () => {
    const items = toInputItems([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'checking', tool_calls: [{ id: 'c1', name: 'getKpis', arguments: '{}' }] },
      { role: 'tool', tool_call_id: 'c1', name: 'getKpis', content: '{}' },
    ]);
    expect(items).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'checking' },
      { type: 'function_call', call_id: 'c1', name: 'getKpis', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: '{}' },
    ]);
  });
});

describe('ResponsesChatClient web search', () => {
  const web = { allowedDomains: ['reuters.com'], maxSearches: 2 };
  const cited: ResponseLike = {
    id: 'r1',
    output: [
      { type: 'web_search_call' },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'Steel is up.',
            annotations: [
              { type: 'url_citation', url: 'https://www.reuters.com/x?utm_source=openai', title: 'Steel jumps' },
              { type: 'url_citation', url: 'https://evil.example.com/y', title: 'nope' },
              { type: 'url_citation', url: 'https://www.reuters.com/x?utm_source=openai', title: 'Steel jumps' },
            ],
          },
        ],
      },
    ],
  };

  it('offers web_search with the domain filter and a tool-call cap, and collects allowed sources', async () => {
    const { api, create } = fakeApi(cited);
    const client = new ResponsesChatClient({ api, model: 'm', tools: [TOOL], webSearch: web, timeoutMs: 1 });

    await client.createCompletion(base);

    const body = create.mock.calls[0][0];
    expect(body.tools).toContainEqual({ type: 'web_search', filters: { allowed_domains: ['reuters.com'] } });
    expect(body.max_tool_calls).toBe(2);
    expect(client.getSources()).toEqual([
      { title: 'Steel jumps', url: 'https://www.reuters.com/x', domain: 'reuters.com' },
    ]);
    expect(client.getSearchCount()).toBe(1);
  });

  it('stops offering web_search once the per-request search cap is reached', async () => {
    const twoSearchesThenCall: ResponseLike = {
      id: 'r1',
      output: [
        { type: 'web_search_call' },
        { type: 'web_search_call' },
        { type: 'function_call', call_id: 'c1', name: 'getKpis', arguments: '{}' },
      ],
    };
    const { api, create } = fakeApi(twoSearchesThenCall, textResponse('done', 'r2'));
    const client = new ResponsesChatClient({ api, model: 'm', tools: [TOOL], webSearch: web, timeoutMs: 1 });

    await client.createCompletion(base);
    await client.createCompletion([
      ...base,
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'getKpis', arguments: '{}' }] },
      { role: 'tool', tool_call_id: 'c1', name: 'getKpis', content: '{}' },
    ]);

    const second = create.mock.calls[1][0];
    expect(second.tools.some((t: { type: string }) => t.type === 'web_search')).toBe(false);
    expect(second.max_tool_calls).toBeUndefined();
    expect(client.getSearchCount()).toBe(2);
  });

  describe('forceSearchFirst', () => {
    const toolCallResponse: ResponseLike = {
      id: 'r1',
      output: [{ type: 'web_search_call' }, { type: 'function_call', call_id: 'c1', name: 'getKpis', arguments: '{}' }],
    };
    const followUp: ChatMessage[] = [
      ...base,
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'getKpis', arguments: '{}' }] },
      { role: 'tool', tool_call_id: 'c1', name: 'getKpis', content: '{}' },
    ];

    it('forces the web_search tool on the first call', async () => {
      const { api, create } = fakeApi(textResponse('x'));
      await new ResponsesChatClient({ api, model: 'm', tools: [TOOL], webSearch: web, timeoutMs: 1, forceSearchFirst: true }).createCompletion(base);
      expect(create.mock.calls[0][0].tool_choice).toEqual({ type: 'web_search' });
    });

    it('never forces it on the chained follow-up call', async () => {
      const { api, create } = fakeApi(toolCallResponse, textResponse('done', 'r2'));
      const client = new ResponsesChatClient({ api, model: 'm', tools: [TOOL], webSearch: web, timeoutMs: 1, forceSearchFirst: true });
      await client.createCompletion(base);
      await client.createCompletion(followUp);
      expect(create.mock.calls[0][0].tool_choice).toEqual({ type: 'web_search' });
      expect(create.mock.calls[1][0].previous_response_id).toBe('r1');
      expect(create.mock.calls[1][0].tool_choice).toBeUndefined();
    });

    it('does not set tool_choice when forceSearchFirst is false or undefined', async () => {
      const { api, create } = fakeApi(textResponse('a'), textResponse('b'));
      await new ResponsesChatClient({ api, model: 'm', tools: [TOOL], webSearch: web, timeoutMs: 1, forceSearchFirst: false }).createCompletion(base);
      await new ResponsesChatClient({ api, model: 'm', tools: [TOOL], webSearch: web, timeoutMs: 1 }).createCompletion(base);
      expect(create.mock.calls[0][0].tool_choice).toBeUndefined();
      expect(create.mock.calls[1][0].tool_choice).toBeUndefined();
    });

    it('does not set tool_choice when no webSearch is configured', async () => {
      const { api, create } = fakeApi(textResponse('a'), textResponse('b'));
      await new ResponsesChatClient({ api, model: 'm', tools: [TOOL], timeoutMs: 1, forceSearchFirst: true }).createCompletion(base);
      await new ResponsesChatClient({ api, model: 'm', tools: [TOOL], webSearch: null, timeoutMs: 1, forceSearchFirst: true }).createCompletion(base);
      expect(create.mock.calls[0][0].tool_choice).toBeUndefined();
      expect(create.mock.calls[1][0].tool_choice).toBeUndefined();
    });
  });

  describe('consulted sources from the search call', () => {
    const searchCall = (urls: string[]): ResponseOutputItem => ({
      type: 'web_search_call',
      action: { sources: urls.map((url) => ({ url })) },
    });
    const citation = (url: string, title: string) => ({ type: 'url_citation', url, title });
    const messageWith = (annotations: { type: string; url?: string; title?: string }[]): ResponseOutputItem => ({
      type: 'message',
      content: [{ type: 'output_text', text: 'Answer.', annotations }],
    });

    it('returns allow-listed consulted sources with derived titles, deduped, when the message has no annotations', async () => {
      const response: ResponseLike = {
        id: 'r1',
        output: [
          searchCall([
            'https://www.reuters.com/markets/steel-tariffs-rise?utm_source=openai',
            'https://evil.example.com/steel-news',
            'https://www.reuters.com/markets/steel-tariffs-rise',
            'https://www.reuters.com/business/freight-rates-jump.html',
          ]),
          messageWith([]),
        ],
      };
      const { api } = fakeApi(response);
      const client = new ResponsesChatClient({ api, model: 'm', tools: [TOOL], webSearch: web, timeoutMs: 1 });
      await client.createCompletion(base);

      expect(client.getSources()).toEqual([
        { title: 'steel tariffs rise', url: 'https://www.reuters.com/markets/steel-tariffs-rise', domain: 'reuters.com' },
        { title: 'freight rates jump', url: 'https://www.reuters.com/business/freight-rates-jump.html', domain: 'reuters.com' },
      ]);
      expect(client.getSearchCount()).toBe(1);
    });

    it('lists cited sources first, then consulted, collapses duplicates across the two, and caps the total at 8', async () => {
      const consulted = Array.from({ length: 7 }, (_, i) => `https://www.reuters.com/news/consulted-item-${i}`);
      const response: ResponseLike = {
        id: 'r1',
        output: [
          searchCall([consulted[0], 'https://www.reuters.com/news/cited-two', ...consulted.slice(1)]),
          messageWith([
            citation('https://www.reuters.com/news/cited-one', 'Cited one'),
            citation('https://www.reuters.com/news/cited-two', 'Cited two'),
            citation('https://www.reuters.com/news/cited-three', 'Cited three'),
          ]),
        ],
      };
      const { api } = fakeApi(response);
      const client = new ResponsesChatClient({ api, model: 'm', tools: [TOOL], webSearch: web, timeoutMs: 1 });
      await client.createCompletion(base);

      const sources = client.getSources();
      expect(sources).toHaveLength(8);
      expect(sources.slice(0, 3).map((s) => s.title)).toEqual(['Cited one', 'Cited two', 'Cited three']);
      // 3 cited + 7 distinct consulted (cited-two is listed by both and collapses) = 10, capped at 8: consulted 5 and 6 are cut.
      expect(sources[3].url).toBe('https://www.reuters.com/news/consulted-item-0');
      expect(sources.map((s) => s.url)).not.toContain('https://www.reuters.com/news/consulted-item-5');
      expect(new Set(sources.map((s) => s.url)).size).toBe(8);
    });

    it('an annotation title wins over a title derived from the same url', async () => {
      const url = 'https://www.reuters.com/news/steel-tariffs-rise';
      const { api } = fakeApi({ id: 'r1', output: [searchCall([url]), messageWith([citation(url, 'Reuters: Steel tariffs')])] });
      const client = new ResponsesChatClient({ api, model: 'm', tools: [TOOL], webSearch: web, timeoutMs: 1 });
      await client.createCompletion(base);
      expect(client.getSources()).toEqual([{ title: 'Reuters: Steel tariffs', url, domain: 'reuters.com' }]);
    });

    it('keeps sources from a first response that also asked for a tool after the final response has no annotations', async () => {
      const first: ResponseLike = {
        id: 'r1',
        output: [
          searchCall(['https://www.reuters.com/markets/steel-tariffs-rise']),
          { type: 'function_call', call_id: 'c1', name: 'getKpis', arguments: '{}' },
        ],
      };
      const { api } = fakeApi(first, textResponse('Final answer, no annotations.', 'r2'));
      const client = new ResponsesChatClient({ api, model: 'm', tools: [TOOL], webSearch: web, timeoutMs: 1, forceSearchFirst: true });
      await client.createCompletion(base);
      await client.createCompletion([
        ...base,
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'getKpis', arguments: '{}' }] },
        { role: 'tool', tool_call_id: 'c1', name: 'getKpis', content: '{}' },
      ]);

      expect(client.getSearchCount()).toBe(1);
      expect(client.getSources()).toEqual([
        { title: 'steel tariffs rise', url: 'https://www.reuters.com/markets/steel-tariffs-rise', domain: 'reuters.com' },
      ]);
    });

    it('ignores search-call sources with a missing or malformed url', async () => {
      const { api } = fakeApi({
        id: 'r1',
        output: [{ type: 'web_search_call', action: { sources: [{}, { url: 'not a url' }, { url: 'javascript:alert(1)' }] } }, { type: 'web_search_call' }],
      });
      const client = new ResponsesChatClient({ api, model: 'm', tools: [TOOL], webSearch: web, timeoutMs: 1 });
      await client.createCompletion(base);
      expect(client.getSources()).toEqual([]);
      expect(client.getSearchCount()).toBe(2);
    });

    it('requests the search-call sources only while web search is offered', async () => {
      const twoSearchesThenCall: ResponseLike = {
        id: 'r1',
        output: [{ type: 'web_search_call' }, { type: 'web_search_call' }, { type: 'function_call', call_id: 'c1', name: 'getKpis', arguments: '{}' }],
      };
      const { api, create } = fakeApi(twoSearchesThenCall, textResponse('done', 'r2'), textResponse('x'));
      const client = new ResponsesChatClient({ api, model: 'm', tools: [TOOL], webSearch: web, timeoutMs: 1 });
      await client.createCompletion(base);
      await client.createCompletion([
        ...base,
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'getKpis', arguments: '{}' }] },
        { role: 'tool', tool_call_id: 'c1', name: 'getKpis', content: '{}' },
      ]);
      await new ResponsesChatClient({ api, model: 'm', tools: [TOOL], timeoutMs: 1 }).createCompletion(base);

      expect(create.mock.calls[0][0].include).toEqual(['web_search_call.action.sources']);
      // Search cap reached: the search tool is no longer offered, so no include either.
      expect(create.mock.calls[1][0].include).toBeUndefined();
      // No webSearch configured at all.
      expect(create.mock.calls[2][0].include).toBeUndefined();
    });
  });

  it('never offers web_search when it is not configured', async () => {
    const { api, create } = fakeApi(textResponse('x'));
    await new ResponsesChatClient({ api, model: 'm', tools: [TOOL], timeoutMs: 1 }).createCompletion(base);
    expect(create.mock.calls[0][0].tools.some((t: { type: string }) => t.type === 'web_search')).toBe(false);
    expect(create.mock.calls[0][0].max_tool_calls).toBeUndefined();
  });
});
