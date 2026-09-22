import { describe, it, expect } from 'vitest';
import { formatTokens, tokenLabelFor, type UsageStats } from '../tokenLabels';

describe('formatTokens', () => {
  it('handles missing or invalid values', () => {
    expect(formatTokens(null)).toBe('not measured yet');
    expect(formatTokens(undefined)).toBe('not measured yet');
    expect(formatTokens(Number.NaN)).toBe('not measured yet');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('not measured yet');
  });

  it('formats zero', () => {
    expect(formatTokens(0)).toBe('0 tokens');
  });

  it('formats sub-1000 counts exactly', () => {
    expect(formatTokens(850)).toBe('≈ 850 tokens');
    expect(formatTokens(1)).toBe('≈ 1 tokens');
  });

  it('formats thousands with one decimal, dropping trailing .0', () => {
    expect(formatTokens(1200)).toBe('≈ 1.2k tokens');
    expect(formatTokens(1000)).toBe('≈ 1k tokens');
    expect(formatTokens(9999)).toBe('≈ 10k tokens');
  });

  it('formats 10k and above rounded to whole k', () => {
    expect(formatTokens(12345)).toBe('≈ 12k tokens');
    expect(formatTokens(10000)).toBe('≈ 10k tokens');
  });
});

describe('tokenLabelFor', () => {
  const usage: UsageStats = {
    briefing: { totalTokens: 12000, date: '2026-09-21', model: 'gpt-x' },
    webAnswer: { avgTokens: 850, samples: 12 },
    dataAnswer: { avgTokens: 400, samples: 30 },
  };

  it('snapshot and situations always cost nothing', () => {
    expect(tokenLabelFor('snapshot', usage)).toBe('0 tokens');
    expect(tokenLabelFor('situations', usage)).toBe('0 tokens');
    expect(tokenLabelFor('snapshot', null)).toBe('0 tokens');
  });

  it('news reports the daily briefing total', () => {
    expect(tokenLabelFor('news', usage)).toBe('≈ 12k tokens per day');
  });

  it('news falls back when usage is unavailable', () => {
    expect(tokenLabelFor('news', null)).toBe('not measured yet');
    expect(tokenLabelFor('news', { briefing: null, webAnswer: null, dataAnswer: null })).toBe('not measured yet');
  });

  it('liveNews reports the average web-answer tokens', () => {
    expect(tokenLabelFor('liveNews', usage)).toBe('≈ 850 tokens per news answer');
  });

  it('liveNews falls back when usage is unavailable', () => {
    expect(tokenLabelFor('liveNews', null)).toBe('not measured yet');
    expect(tokenLabelFor('liveNews', { briefing: null, webAnswer: null, dataAnswer: null })).toBe('not measured yet');
  });
});
