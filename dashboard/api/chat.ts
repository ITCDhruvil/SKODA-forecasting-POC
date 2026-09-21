import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadChatConfig } from './_lib/config';
import { kv } from './_lib/kvClient';
import { createOpenAIResponsesApi } from './_lib/openaiApi';
import { answer, type IncomingMessage } from './_lib/orchestrator';
import { checkRateLimit } from './_lib/rateLimit';
import { checkWebBudget } from './_lib/webBudget';

const MAX_MESSAGES = 30;
const MAX_MESSAGE_LENGTH = 4000;

function isValidIncomingMessage(m: unknown): m is IncomingMessage {
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

  const body = req.body as { messages?: unknown; webEnabled?: unknown } | undefined;
  if (
    !body ||
    !Array.isArray(body.messages) ||
    !body.messages.every(isValidIncomingMessage) ||
    (body.webEnabled !== undefined && typeof body.webEnabled !== 'boolean')
  ) {
    res.status(400).json({ error: 'invalid request body' });
    return;
  }

  // The conversation must be non-empty and end with the user's question.
  if (body.messages.length === 0 || body.messages[body.messages.length - 1].role !== 'user') {
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

  try {
    const result = await answer(
      {
        // Only role and content are forwarded; any extra client fields are dropped.
        messages: (body.messages as IncomingMessage[]).map(({ role, content }) => ({ role, content })),
        webEnabled: body.webEnabled ?? true,
        ip,
      },
      {
        api: createOpenAIResponsesApi(apiKey),
        config: loadChatConfig(),
        checkBudget: (clientIp) => checkWebBudget(kv, clientIp),
      },
    );
    res.status(200).json(result);
  } catch (err) {
    console.error('chat endpoint error', err);
    res.status(502).json({ error: 'chat temporarily unavailable' });
  }
}
