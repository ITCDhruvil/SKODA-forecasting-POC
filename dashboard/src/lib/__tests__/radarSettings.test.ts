import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  loadSettings,
  saveSettings,
  type RadarSettings,
} from '../radarSettings';

const LEGACY_WEB_KEY = 'radar-web-enabled-v1';

function fakeStorage(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    peek: () => store,
  };
}

describe('DEFAULT_SETTINGS', () => {
  it('has every feature on', () => {
    expect(DEFAULT_SETTINGS).toEqual({ snapshot: true, news: true, situations: true, liveNews: true });
  });
});

describe('loadSettings', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadSettings(fakeStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults for corrupt JSON', () => {
    expect(loadSettings(fakeStorage({ [SETTINGS_KEY]: 'not json{' }))).toEqual(DEFAULT_SETTINGS);
  });

  it('returns defaults when storage throws', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadSettings(blocked)).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips a valid settings object', () => {
    const s: RadarSettings = { snapshot: false, news: true, situations: false, liveNews: true };
    expect(loadSettings(fakeStorage({ [SETTINGS_KEY]: JSON.stringify(s) }))).toEqual(s);
  });

  it('ignores unknown keys', () => {
    const raw = JSON.stringify({ ...DEFAULT_SETTINGS, mystery: true, snapshot: false });
    expect(loadSettings(fakeStorage({ [SETTINGS_KEY]: raw }))).toEqual({ ...DEFAULT_SETTINGS, snapshot: false });
  });

  it('falls back to the default for any key with a non-boolean value', () => {
    const raw = JSON.stringify({ snapshot: 'yes', news: true, situations: 1, liveNews: false });
    expect(loadSettings(fakeStorage({ [SETTINGS_KEY]: raw }))).toEqual({
      snapshot: true,
      news: true,
      situations: true,
      liveNews: false,
    });
  });

  it('migrates from the legacy web-preference key when the new key is absent and legacy is off', () => {
    const storage = fakeStorage({ [LEGACY_WEB_KEY]: 'false' });
    expect(loadSettings(storage)).toEqual({ ...DEFAULT_SETTINGS, liveNews: false });
  });

  it('does not migrate when the legacy key is present but on', () => {
    const storage = fakeStorage({ [LEGACY_WEB_KEY]: 'true' });
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it('ignores the legacy key once the new key exists', () => {
    const s: RadarSettings = { ...DEFAULT_SETTINGS, liveNews: true };
    const storage = fakeStorage({ [LEGACY_WEB_KEY]: 'false', [SETTINGS_KEY]: JSON.stringify(s) });
    expect(loadSettings(storage)).toEqual(s);
  });
});

describe('saveSettings', () => {
  it('persists settings that loadSettings can read back', () => {
    const storage = fakeStorage();
    const s: RadarSettings = { snapshot: true, news: false, situations: true, liveNews: false };
    saveSettings(storage, s);
    expect(loadSettings(storage)).toEqual(s);
  });

  it('never throws when storage is blocked', () => {
    const blocked = {
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => saveSettings(blocked, DEFAULT_SETTINGS)).not.toThrow();
  });
});
