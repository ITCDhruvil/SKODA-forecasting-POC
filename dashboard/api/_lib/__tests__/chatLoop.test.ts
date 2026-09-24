import { describe, it, expect, vi } from 'vitest';
import { runChatLoop, type ChatClient, type ChatMessage } from '../chatLoop';

function fakeClient(
  responses: { content: string | null; toolCalls: { id: string; name: string; arguments: string }[] }[],
): ChatClient {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  // repeat the last response for any calls beyond the provided list
  create.mockResolvedValue(responses[responses.length - 1]);
  return { createCompletion: create };
}

const baseMessages: ChatMessage[] = [{ role: 'user', content: 'hello' }];

describe('runChatLoop', () => {
  it('returns text directly when the model makes no tool call', async () => {
    const client = fakeClient([{ content: 'hi there', toolCalls: [] }]);
    const result = await runChatLoop(client, {}, baseMessages);
    expect(result).toBe('hi there');
    expect(client.createCompletion).toHaveBeenCalledTimes(1);
  });

  it('executes a requested tool and feeds the result back before returning', async () => {
    const handler = vi.fn().mockReturnValue({ kpis: [{ id: 'basket' }] });
    const client = fakeClient([
      { content: null, toolCalls: [{ id: 'call_1', name: 'getKpis', arguments: '{}' }] },
      { content: 'the basket kpi is X', toolCalls: [] },
    ]);

    const result = await runChatLoop(client, { getKpis: handler }, baseMessages);

    expect(result).toBe('the basket kpi is X');
    expect(handler).toHaveBeenCalledWith({});
    const secondCallMessages = (client.createCompletion as any).mock.calls[1][0] as ChatMessage[];
    const toolMessage = secondCallMessages.find((m) => m.role === 'tool');
    expect(toolMessage?.tool_call_id).toBe('call_1');
    expect(toolMessage?.content).toBe(JSON.stringify({ kpis: [{ id: 'basket' }] }));
  });

  it('reports an unknown tool name back to the model instead of throwing', async () => {
    const client = fakeClient([
      { content: null, toolCalls: [{ id: 'call_1', name: 'doesNotExist', arguments: '{}' }] },
      { content: 'ok', toolCalls: [] },
    ]);

    const result = await runChatLoop(client, {}, baseMessages);

    expect(result).toBe('ok');
    const secondCallMessages = (client.createCompletion as any).mock.calls[1][0] as ChatMessage[];
    const toolMessage = secondCallMessages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('unknown tool');
  });

  it('sanitizes a handler-throw into a generic error instead of leaking the raw message', async () => {
    const handler = vi.fn().mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory, open '/var/task/api/_data/dashboard.json'");
    });
    const client = fakeClient([
      { content: null, toolCalls: [{ id: 'call_1', name: 'getKpis', arguments: '{}' }] },
      { content: 'ok', toolCalls: [] },
    ]);

    const result = await runChatLoop(client, { getKpis: handler }, baseMessages);

    expect(result).toBe('ok');
    const secondCallMessages = (client.createCompletion as any).mock.calls[1][0] as ChatMessage[];
    const toolMessage = secondCallMessages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toBe(JSON.stringify({ error: 'data unavailable: getKpis' }));
    expect(toolMessage?.content).not.toContain('ENOENT');
    expect(toolMessage?.content).not.toContain('/var/task');
  });

  it('awaits an async handler and serializes its resolved value (regression: un-awaited handler used to serialize to "{}")', async () => {
    const handler = vi.fn().mockResolvedValue({ alerts: [{ alertId: 'x', status: 'pending' }] });
    const client = fakeClient([
      { content: null, toolCalls: [{ id: 'call_1', name: 'getGeoHitlAlerts', arguments: '{}' }] },
      { content: 'here are the alerts', toolCalls: [] },
    ]);

    const result = await runChatLoop(client, { getGeoHitlAlerts: handler }, baseMessages);

    expect(result).toBe('here are the alerts');
    const secondCallMessages = (client.createCompletion as any).mock.calls[1][0] as ChatMessage[];
    const toolMessage = secondCallMessages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).not.toBe('{}');
    expect(JSON.parse(toolMessage!.content as string)).toEqual({
      alerts: [{ alertId: 'x', status: 'pending' }],
    });
  });

  it('sanitizes a rejected async handler into a generic error instead of leaking the raw message', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('kv down'));
    const client = fakeClient([
      { content: null, toolCalls: [{ id: 'call_1', name: 'confirmGeoAlert', arguments: '{}' }] },
      { content: 'ok', toolCalls: [] },
    ]);

    const result = await runChatLoop(client, { confirmGeoAlert: handler }, baseMessages);

    expect(result).toBe('ok');
    const secondCallMessages = (client.createCompletion as any).mock.calls[1][0] as ChatMessage[];
    const toolMessage = secondCallMessages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toBe(JSON.stringify({ error: 'data unavailable: confirmGeoAlert' }));
    expect(toolMessage?.content).not.toContain('kv down');
  });

  it('stops after MAX_ITERATIONS and returns a fallback message', async () => {
    const client: ChatClient = {
      createCompletion: vi
        .fn()
        .mockResolvedValue({ content: null, toolCalls: [{ id: 'call_x', name: 'getKpis', arguments: '{}' }] }),
    };

    const result = await runChatLoop(client, { getKpis: () => ({}) }, baseMessages);

    expect(result).toContain("wasn't able to finish");
    expect(client.createCompletion).toHaveBeenCalledTimes(6);
  });
});
