import type { VercelRequest, VercelResponse } from '@vercel/node';
import { checkRateLimit } from './_lib/rateLimit';
import { getAllStatuses, setStatus } from './_lib/hitlStatus';
import { kv } from './_lib/kvClient';

function isValidStatus(s: unknown): s is 'confirmed' | 'dismissed' {
  return s === 'confirmed' || s === 'dismissed';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip =
    (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';

  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    res.status(429).json({ error: 'too many requests, try again in a few minutes' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const statuses = await getAllStatuses(kv);
      if ('error' in statuses) {
        res.status(502).json(statuses);
        return;
      }
      res.status(200).json({ statuses });
      return;
    }

    if (req.method === 'POST') {
      const body = req.body as { alertId?: unknown; status?: unknown } | undefined;
      if (!body || typeof body.alertId !== 'string' || !isValidStatus(body.status)) {
        res.status(400).json({ error: 'invalid request body' });
        return;
      }
      const result = await setStatus(kv, body.alertId, body.status);
      if ('error' in result) {
        res.status(result.error === 'unknown alertId' ? 400 : 502).json(result);
        return;
      }
      res.status(200).json(result);
      return;
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('hitl-status endpoint error', err);
    res.status(502).json({ error: 'hitl status unavailable' });
  }
}
