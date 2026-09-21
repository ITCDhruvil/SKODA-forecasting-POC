import { describe, it, expect } from 'vitest';
import { loadWebEnabled, saveWebEnabled, WEB_PREF_KEY } from '../webPreference';

describe('web preference', () => {
  it('defaults to on', () => {
    expect(loadWebEnabled({ getItem: () => null })).toBe(true);
  });

  it('round-trips off and on', () => {
    const store: Record<string, string> = {};
    const storage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) };
    saveWebEnabled(storage, false);
    expect(store[WEB_PREF_KEY]).toBe('false');
    expect(loadWebEnabled(storage)).toBe(false);
    saveWebEnabled(storage, true);
    expect(loadWebEnabled(storage)).toBe(true);
  });

  it('never throws when storage is blocked', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadWebEnabled(blocked)).toBe(true);
    expect(() => saveWebEnabled(blocked, false)).not.toThrow();
  });
});
