export interface RadarSettings {
  snapshot: boolean;
  news: boolean;
  situations: boolean;
  liveNews: boolean;
}

export const DEFAULT_SETTINGS: RadarSettings = {
  snapshot: true,
  news: true,
  situations: true,
  liveNews: true,
};

export const SETTINGS_KEY = 'radar-settings-v1';

/** Pre-Task-10b preference key: 'false' meant live news was off. Migrated once, then ignored. */
const LEGACY_WEB_KEY = 'radar-web-enabled-v1';

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof RadarSettings)[];

/** Defaults, with `liveNews` carried over from the legacy web-preference key when it was explicitly off. */
function migrateFromLegacy(storage: Pick<Storage, 'getItem'>): RadarSettings {
  try {
    if (storage.getItem(LEGACY_WEB_KEY) === 'false') return { ...DEFAULT_SETTINGS, liveNews: false };
  } catch {
    /* legacy key unreadable: fall through to plain defaults */
  }
  return { ...DEFAULT_SETTINGS };
}

/**
 * Reads the stored Radar settings; never throws. Missing, corrupt or blocked storage yields defaults (with the
 * one-time migration above); unknown keys are ignored and a non-boolean value for a known key falls back to that
 * key's default rather than discarding the whole object.
 */
export function loadSettings(storage: Pick<Storage, 'getItem'>): RadarSettings {
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    if (raw === null) return migrateFromLegacy(storage);

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS };
    const o = parsed as Record<string, unknown>;

    const out = { ...DEFAULT_SETTINGS };
    for (const key of KEYS) {
      if (typeof o[key] === 'boolean') out[key] = o[key];
    }
    return out;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(storage: Pick<Storage, 'setItem'>, s: RadarSettings): void {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage blocked or quota exceeded: the settings just won't persist */
  }
}
