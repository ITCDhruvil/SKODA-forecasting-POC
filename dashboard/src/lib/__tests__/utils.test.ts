import { describe, it, expect } from 'vitest';
import { cn } from '../utils';

describe('cn', () => {
  it('joins class names and drops falsy values', () => {
    expect(cn('a', false && 'b', undefined, 'c')).toBe('a c');
  });

  it('lets later Tailwind v3 classes override conflicting earlier ones', () => {
    expect(cn('rounded-2xl p-2', 'rounded-full')).toBe('p-2 rounded-full');
    expect(cn('bg-gradient-to-r from-brand-600', 'bg-gradient-to-l')).toBe('from-brand-600 bg-gradient-to-l');
  });
});
