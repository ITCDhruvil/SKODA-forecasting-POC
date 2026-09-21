import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runChatLoop, type ChatMessage } from './_lib/chatLoop';
import { createOpenAIResponsesApi } from './_lib/openaiApi';
import { checkRateLimit } from './_lib/rateLimit';
import { ResponsesChatClient } from './_lib/responsesClient';
import { SYSTEM_PROMPT } from './_lib/systemPrompt';
import { TOOL_DEFINITIONS, TOOL_HANDLERS } from './_lib/tools';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_MESSAGES = 30;
const MAX_MESSAGE_LENGTH = 4000;
const OPENAI_TIMEOUT_MS = 25_000;

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

  if (body.messages.length > MAX_MESSAGES) {
    res.status(400).json({ error: 'too many messages' });
    return;
  }
  if (body.messages.some((m) => m.content.length > MAX_MESSAGE_LENGTH)) {
    res.status(400).json({ error: 'message too long' });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(502).json({ error: 'chat temporarily unavailable' });
    return;
  }

  // Only role and content are forwarded; any extra client fields are dropped.
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(body.messages as { role: 'user' | 'assistant'; content: string }[]).map(({ role, content }) => ({
      role,
      content,
    })),
  ];

  try {
    const client = new ResponsesChatClient({
      api: createOpenAIResponsesApi(apiKey),
      model: MODEL,
      tools: TOOL_DEFINITIONS,
      timeoutMs: OPENAI_TIMEOUT_MS,
    });
    const reply = await runChatLoop(client, TOOL_HANDLERS, messages);
    res.status(200).json({ reply });
  } catch (err) {
    console.error('chat endpoint error', err);
    res.status(502).json({ error: 'chat temporarily unavailable' });
  }
}
