import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, _resetRateLimitForTests } from '../rateLimit';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 20;

describe('checkRateLimit', () => {
  beforeEach(() => {
    _resetRateLimitForTests();
  });

  it('allows requests under the limit', () => {
    const now = 0;
    for (let i = 0; i < MAX_REQUESTS; i++) {
      expect(checkRateLimit('1.2.3.4', now).allowed).toBe(true);
    }
  });

  it('blocks the request that exceeds the limit within the window', () => {
    const now = 0;
    for (let i = 0; i < MAX_REQUESTS; i++) checkRateLimit('1.2.3.4', now);
    const result = checkRateLimit('1.2.3.4', now);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('tracks separate keys independently', () => {
    const now = 0;
    for (let i = 0; i < MAX_REQUESTS; i++) checkRateLimit('1.2.3.4', now);
    expect(checkRateLimit('5.6.7.8', now).allowed).toBe(true);
  });

  it('resets once the window elapses', () => {
    const start = 0;
    for (let i = 0; i < MAX_REQUESTS; i++) checkRateLimit('1.2.3.4', start);
    expect(checkRateLimit('1.2.3.4', start).allowed).toBe(false);

    const afterWindow = start + WINDOW_MS + 1;
    expect(checkRateLimit('1.2.3.4', afterWindow).allowed).toBe(true);
  });
});
