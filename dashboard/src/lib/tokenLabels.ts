import type { RadarSettings } from './radarSettings';

/** Body of `GET /api/usage`, mirrored from the server (api/_lib/usageStats.ts). */
export interface UsageStats {
  briefing: { totalTokens: number; date: string; model: string } | null;
  webAnswer: { avgTokens: number; samples: number } | null;
  dataAnswer: { avgTokens: number; samples: number } | null;
}

/** Human-readable approximate token count, e.g. "≈ 1.2k tokens" or "≈ 12k tokens". */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'not measured yet';
  if (n === 0) return '0 tokens';
  if (n < 1000) return `≈ ${n} tokens`;
  if (n < 10_000) {
    const thousands = (n / 1000).toFixed(1).replace(/\.0$/, '');
    return `≈ ${thousands}k tokens`;
  }
  return `≈ ${Math.round(n / 1000)}k tokens`;
}

/** Approximate token-cost label for one settings row, from real usage stats when available. */
export function tokenLabelFor(feature: keyof RadarSettings, usage: UsageStats | null): string {
  if (feature === 'snapshot' || feature === 'situations') return '0 tokens';
  if (feature === 'news') {
    return usage?.briefing ? `${formatTokens(usage.briefing.totalTokens)} per day` : 'not measured yet';
  }
  // feature === 'liveNews'
  return usage?.webAnswer ? `${formatTokens(usage.webAnswer.avgTokens)} per news answer` : 'not measured yet';
}
