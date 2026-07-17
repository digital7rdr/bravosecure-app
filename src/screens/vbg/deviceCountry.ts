import {NativeModules, Platform} from 'react-native';

/**
 * Best-effort ISO-3166 alpha-2 country code for the device — derived from the
 * device LOCALE, fully OFFLINE (no network, no extra dependency). Used to pin
 * the user's likely country at the top of the emergency-services list.
 *
 * We read the platform locale identifier (e.g. "en_BD", "en-US") and extract
 * the region tag. `Intl` is used as a secondary source. Returns null if no
 * region can be determined, in which case the caller falls back to the plain
 * alphabetical list.
 */
export function getDeviceCountryIso(): string | null {
  const candidates: string[] = [];

  try {
    if (Platform.OS === 'ios') {
      const s = NativeModules.SettingsManager?.settings;
      if (s?.AppleLocale) {candidates.push(String(s.AppleLocale));}
      if (Array.isArray(s?.AppleLanguages) && s.AppleLanguages[0]) {
        candidates.push(String(s.AppleLanguages[0]));
      }
    } else {
      const loc = NativeModules.I18nManager?.localeIdentifier;
      if (loc) {candidates.push(String(loc));}
    }
  } catch {
    /* native module shape varies by RN version — fall through to Intl */
  }

  // Secondary: Intl resolved locale (present on Hermes with Intl enabled).
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
    if (resolved) {candidates.push(resolved);}
  } catch {
    /* Intl may be absent */
  }

  for (const raw of candidates) {
    const iso = regionFromLocale(raw);
    if (iso) {return iso;}
  }
  return null;
}

/** Extract a 2-letter region from a locale like "en_BD" / "en-US" / "fr-FR". */
function regionFromLocale(locale: string): string | null {
  // Split on - or _ and find a 2-letter ALL-CAPS-ish segment (the region).
  const parts = locale.replace(/@.*$/, '').split(/[-_]/);
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (/^[A-Za-z]{2}$/.test(p)) {return p.toUpperCase();}
  }
  return null;
}
