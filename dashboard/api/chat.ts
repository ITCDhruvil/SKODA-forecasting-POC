import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';
import { runChatLoop, type ChatClient, type ChatMessage } from './_lib/chatLoop';
import { checkRateLimit } from './_lib/rateLimit';
import { TOOL_DEFINITIONS, TOOL_HANDLERS } from './_lib/tools';
import { SYSTEM_PROMPT } from './_lib/systemPrompt';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function toOpenAIMessage(m: ChatMessage): OpenAI.Chat.ChatCompletionMessageParam {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.tool_call_id!, content: m.content ?? '' };
  }
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.tool_calls?.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  return { role: m.role, content: m.content ?? '' };
}

class OpenAIChatClient implements ChatClient {
  private openai: OpenAI;
  private model: string;

  constructor(openai: OpenAI, model: string) {
    this.openai = openai;
    this.model = model;
  }

  async createCompletion(messages: ChatMessage[]) {
    const completion = await this.openai.chat.completions.create({
      model: this.model,
      messages: messages.map(toOpenAIMessage),
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto',
    });
    const choice = completion.choices[0].message;
    const toolCalls = (choice.tool_calls ?? [])
      .filter((tc): tc is OpenAI.Chat.ChatCompletionMessageToolCall & { type: 'function' } => tc.type === 'function')
      .map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }));
    return { content: choice.content, toolCalls };
  }
}

function isValidIncomingMessage(m: unknown): m is { role: 'user' | 'assistant'; content: string } {
  if (!m || typeof m !== 'object') return false;
  const obj = m as Record<string, unknown>;
  return (obj.role === 'user' || obj.role === 'assistant') && typeof obj.content === 'string';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const forwardedFor = req.headers['x-forwarded-for'];
  const ip =
    (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';

  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    res.status(429).json({ error: 'too many messages, try again in a few minutes' });
    return;
  }

  const body = req.body as { messages?: unknown } | undefined;
  if (!body || !Array.isArray(body.messages) || !body.messages.every(isValidIncomingMessage)) {
    res.status(400).json({ error: 'invalid request body' });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    res.status(502).json({ error: 'chat temporarily unavailable' });
    return;
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(body.messages as { role: 'user' | 'assistant'; content: string }[]),
  ];

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const client = new OpenAIChatClient(openai, MODEL);
    const reply = await runChatLoop(client, TOOL_HANDLERS, messages);
    res.status(200).json({ reply });
  } catch (err) {
    console.error('chat endpoint error', err);
    res.status(502).json({ error: 'chat temporarily unavailable' });
  }
}
