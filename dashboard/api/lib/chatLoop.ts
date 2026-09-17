export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatClient {
  createCompletion(messages: ChatMessage[]): Promise<{ content: string | null; toolCalls: ToolCall[] }>;
}

export const MAX_ITERATIONS = 6;

const FALLBACK_MESSAGE =
  "I wasn't able to finish that one — could you rephrase or ask something more specific?";

export async function runChatLoop(
  client: ChatClient,
  handlers: Record<string, (args: any) => unknown>,
  initialMessages: ChatMessage[],
): Promise<string> {
  const messages: ChatMessage[] = [...initialMessages];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.createCompletion(messages);

    if (!response.toolCalls || response.toolCalls.length === 0) {
      return response.content ?? '';
    }

    messages.push({ role: 'assistant', content: response.content, tool_calls: response.toolCalls });

    for (const call of response.toolCalls) {
      const handler = handlers[call.name];
      let result: unknown;
      if (!handler) {
        result = { error: `unknown tool: ${call.name}` };
      } else {
        try {
          const args = call.arguments ? JSON.parse(call.arguments) : {};
          result = handler(args);
        } catch (err) {
          result = { error: `tool ${call.name} failed: ${(err as Error).message}` };
        }
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: JSON.stringify(result),
      });
    }
  }

  return FALLBACK_MESSAGE;
}
