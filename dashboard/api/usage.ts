import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from './_lib/kvClient';
import { checkRateLimit } from './_lib/rateLimit';
import { readUsage } from './_lib/usageStats';

/**
 * GET /api/usage: token figures for the Radar settings screen (spec section 12). Never a 5xx: when the store
 * cannot be read the three parts are null.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
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
    res.status(429).json({ error: 'too many requests, try again in a few minutes' });
    return;
  }

  try {
    res.status(200).json(await readUsage(kv));
  } catch (err) {
    console.error('usage endpoint error', err instanceof Error ? err.name : 'unknown error');
    res.status(200).json({ briefing: null, webAnswer: null, dataAnswer: null });
  }
}
