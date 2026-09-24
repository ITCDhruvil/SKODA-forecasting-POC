import { describe, it, expect } from 'vitest';
import { GOLDEN_CASES, type GoldenCase } from '../routerGolden';
import { passes, percentile, runRouterEval } from '../routerEval';

const cases: GoldenCase[] = [
  { id: 'a', message: 'm1', expected: 'data' },
  { id: 'b', message: 'm2', expected: 'web' },
  { id: 'c', message: 'm3', expected: 'action', critical: true },
  { id: 'd', message: 'm4', expected: 'data' },
];

describe('runRouterEval', () => {
  it('scores accuracy, lists failures and counts critical failures', async () => {
    const result = await runRouterEval(cases, async (c) => (c.id === 'b' ? 'data' : c.id === 'c' ? 'web' : c.expected));
    expect(result.total).toBe(4);
    expect(result.correct).toBe(2);
    expect(result.accuracy).toBe(0.5);
    expect(result.failures).toEqual([
      { id: 'b', expected: 'web', got: 'data' },
      { id: 'c', expected: 'action', got: 'web' },
    ]);
    expect(result.criticalFailures).toBe(1);
    expect(passes(result)).toBe(false);
  });

  it('passes at >= 95% with no critical failure', async () => {
    const many = Array.from({ length: 20 }, (_, i): GoldenCase => ({ id: `c${i}`, message: 'x', expected: 'data' }));
    const result = await runRouterEval(many, async (c) => (c.id === 'c0' ? 'web' : 'data'));
    expect(result.accuracy).toBe(0.95);
    expect(passes(result)).toBe(true);
  });

  it('fails on a single critical failure even when accuracy is 99%', async () => {
    const hundred = Array.from({ length: 100 }, (_, i): GoldenCase =>
      i === 0 ? { id: 'crit', message: 'x', expected: 'action', critical: true } : { id: `c${i}`, message: 'x', expected: 'data' },
    );
    const result = await runRouterEval(hundred, async (c) => (c.id === 'crit' ? 'data' : c.expected));
    expect(result.accuracy).toBe(0.99);
    expect(result.criticalFailures).toBe(1);
    expect(passes(result)).toBe(false);
  });

  it('measures latency percentiles with an injected clock', async () => {
    let t = 0;
    const result = await runRouterEval(
      cases,
      async (c) => {
        t += 100;
        return c.expected;
      },
      () => t,
    );
    // Cases in a batch run concurrently, so exact values depend on batching; assert the shape only.
    expect(result.p50Ms).toBeGreaterThan(0);
    expect(result.p95Ms).toBeGreaterThanOrEqual(result.p50Ms);
  });
});

describe('percentile', () => {
  it('returns the nearest-rank value', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('GOLDEN_CASES', () => {
  it('has unique ids, valid labels and coverage of every mode', () => {
    const ids = GOLDEN_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(GOLDEN_CASES.length).toBeGreaterThanOrEqual(30);
    for (const mode of ['data', 'web', 'action'] as const) {
      expect(GOLDEN_CASES.filter((c) => c.expected === mode).length).toBeGreaterThanOrEqual(6);
    }
    for (const c of GOLDEN_CASES) expect(['data', 'web', 'action']).toContain(c.expected);
  });

  it('only marks action cases as critical', () => {
    const critical = GOLDEN_CASES.filter((c) => c.critical);
    expect(critical.length).toBeGreaterThan(0);
    for (const c of critical) expect(c.expected).toBe('action');
  });
});
