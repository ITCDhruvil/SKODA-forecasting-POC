import { describe, it, expect, vi } from 'vitest';
import {
  ResponsesChatClient,
  extractOutputText,
  toInputItems,
  type ResponseLike,
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
