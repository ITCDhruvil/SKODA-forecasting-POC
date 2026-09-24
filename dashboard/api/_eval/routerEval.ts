import type { Mode } from '../_lib/router';
import type { GoldenCase } from './routerGolden';

export interface EvalResult {
  total: number;
  correct: number;
  accuracy: number;
  criticalFailures: number;
  failures: { id: string; expected: Mode; got: Mode }[];
  p50Ms: number;
  p95Ms: number;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export async function runRouterEval(
  cases: GoldenCase[],
  route: (c: GoldenCase) => Promise<Mode>,
  now: () => number = Date.now,
): Promise<EvalResult> {
  const failures: EvalResult['failures'] = [];
  const latencies: number[] = [];
  let criticalFailures = 0;

  for (let i = 0; i < cases.length; i += 5) {
    const batch = cases.slice(i, i + 5);
    const outcomes = await Promise.all(
      batch.map(async (c) => {
        const t0 = now();
        const got = await route(c);
        return { c, got, ms: now() - t0 };
      }),
    );
    for (const { c, got, ms } of outcomes) {
      latencies.push(ms);
      if (got !== c.expected) {
        failures.push({ id: c.id, expected: c.expected, got });
        if (c.critical) criticalFailures += 1;
      }
    }
  }

  latencies.sort((a, b) => a - b);
  const correct = cases.length - failures.length;
  return {
    total: cases.length,
    correct,
    accuracy: cases.length === 0 ? 0 : correct / cases.length,
    criticalFailures,
    failures,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
  };
}

export function passes(result: EvalResult): boolean {
  return result.accuracy >= 0.95 && result.criticalFailures === 0;
}
