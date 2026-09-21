export const WEB_PREF_KEY = 'radar-web-enabled-v1';

/** Whether live news is switched on for this browser. Defaults to on; never throws. */
export function loadWebEnabled(storage: Pick<Storage, 'getItem'>): boolean {
  try {
    return storage.getItem(WEB_PREF_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function saveWebEnabled(storage: Pick<Storage, 'setItem'>, enabled: boolean): void {
  try {
    storage.setItem(WEB_PREF_KEY, String(enabled));
  } catch {
    /* storage blocked: the preference just won't persist */
  }
}
