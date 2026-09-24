import { describe, it, expect } from 'vitest';
import { THINKING_WORDS, pickThinkingWord } from '../thinkingWords';

describe('pickThinkingWord', () => {
  it('returns a word from the list', () => {
    expect(THINKING_WORDS).toContain(pickThinkingWord(null, () => 0));
    expect(THINKING_WORDS).toContain(pickThinkingWord(null, () => 0.999));
  });

  it('never repeats the previous word back to back', () => {
    for (const previous of THINKING_WORDS) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        expect(pickThinkingWord(previous, () => r)).not.toBe(previous);
      }
    }
  });

  it('has enough variety to feel random', () => {
    expect(new Set(THINKING_WORDS).size).toBeGreaterThanOrEqual(8);
  });
});
