import { describe, it, expect } from 'vitest';
import { greetingFor } from '../greeting';

describe('greetingFor', () => {
  it('says good morning from 5am to 11am', () => {
    expect(greetingFor(5)).toBe('Good morning');
    expect(greetingFor(11)).toBe('Good morning');
  });

  it('says good afternoon from noon to 5pm', () => {
    expect(greetingFor(12)).toBe('Good afternoon');
    expect(greetingFor(17)).toBe('Good afternoon');
  });

  it('says good evening from 6pm through the early hours', () => {
    expect(greetingFor(18)).toBe('Good evening');
    expect(greetingFor(23)).toBe('Good evening');
    expect(greetingFor(0)).toBe('Good evening');
    expect(greetingFor(4)).toBe('Good evening');
  });
});
