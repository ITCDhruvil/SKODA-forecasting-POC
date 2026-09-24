import { describe, it, expect } from 'vitest';
import { SITUATIONS } from '../situations';

describe('SITUATIONS', () => {
  it('has exactly six entries', () => {
    expect(SITUATIONS).toHaveLength(6);
  });

  it('has unique, non-empty labels and questions', () => {
    const labels = new Set(SITUATIONS.map((s) => s.label));
    const questions = new Set(SITUATIONS.map((s) => s.question));
    expect(labels.size).toBe(6);
    expect(questions.size).toBe(6);
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

  it('question 5 (News check) mentions news or current context', () => {
    const question = SITUATIONS[4].question.toLowerCase();
    expect(/news|current/.test(question)).toBe(true);
  });

  it('question 6 (Cost comparison) mentions comparison intent', () => {
    const question = SITUATIONS[5].question.toLowerCase();
    expect(/compare/.test(question)).toBe(true);
  });
});
