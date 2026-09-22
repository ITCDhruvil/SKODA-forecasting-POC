import { describe, it, expect } from 'vitest';
import { SITUATIONS } from '../situations';

describe('SITUATIONS', () => {
  it('has exactly four entries', () => {
    expect(SITUATIONS).toHaveLength(4);
  });

  it('has unique, non-empty labels and questions', () => {
    const labels = new Set(SITUATIONS.map((s) => s.label));
    const questions = new Set(SITUATIONS.map((s) => s.question));
    expect(labels.size).toBe(4);
    expect(questions.size).toBe(4);
    for (const s of SITUATIONS) {
      expect(s.label.trim().length).toBeGreaterThan(0);
      expect(s.question.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps labels short', () => {
    for (const s of SITUATIONS) {
      expect(s.label.length).toBeLessThanOrEqual(24);
    }
  });
});
