// Curated speech-recognition languages (issue #53). One canonical BCP-47 tag
// per language is the only value that gets persisted (desktop settings.json,
// web localStorage) or passed between surfaces; every engine-specific format
// is derived on the way out, never stored:
//   - Web Speech API: recognition.lang takes the BCP-47 tag as-is
//   - capturia-speech helper (apple-speech): --locale in Foundation's
//     underscore form, e.g. Locale(identifier: "es_MX")
//   - whisper.cpp: bare lowercase two-letter code for the -l flag
// The list is deliberately short: each entry is a language all three engines
// actually recognize, not a dump of every BCP-47 tag into a dropdown.

export interface VoiceLocale {
  /** Canonical BCP-47 tag; the persisted value and the picker key. */
  tag: string;
  /** Native-script label for pickers. */
  label: string;
  /** English language name for the agent context (the model reads this). */
  language: string;
}

export const VOICE_LOCALES: readonly VoiceLocale[] = [
  { tag: "en-US", label: "English", language: "English" },
  { tag: "es-MX", label: "Español (México)", language: "Spanish (Mexico)" },
  { tag: "es-ES", label: "Español (España)", language: "Spanish (Spain)" },
  { tag: "pt-BR", label: "Português", language: "Portuguese (Brazil)" },
  { tag: "fr-FR", label: "Français", language: "French" },
  { tag: "de-DE", label: "Deutsch", language: "German" },
  { tag: "it-IT", label: "Italiano", language: "Italian" },
  { tag: "ja-JP", label: "日本語", language: "Japanese" },
];

export const DEFAULT_VOICE_LOCALE = VOICE_LOCALES[0].tag;

/**
 * Coerce anything (stored value, IPC payload, helper echo) to a curated tag.
 * Accepts either separator and any casing so a round trip through an engine
 * format ("es_MX", "es-mx") still lands on the canonical entry; everything
 * else, including undefined and non-strings, falls back to the default.
 */
export function normalizeVoiceLocale(tag: unknown): string {
  if (typeof tag !== "string") return DEFAULT_VOICE_LOCALE;
  const cleaned = tag.trim().replace("_", "-").toLowerCase();
  const hit = VOICE_LOCALES.find((l) => l.tag.toLowerCase() === cleaned);
  return hit ? hit.tag : DEFAULT_VOICE_LOCALE;
}

/** Web Speech API recognition.lang: the canonical BCP-47 tag itself. */
export function webSpeechLang(tag: unknown): string {
  return normalizeVoiceLocale(tag);
}

/** capturia-speech helper --locale: Foundation underscore form ("es_MX"). */
export function appleSpeechLocale(tag: unknown): string {
  return normalizeVoiceLocale(tag).replace("-", "_");
}

/** whisper.cpp -l flag: bare lowercase two-letter language code ("es"). */
export function whisperLanguage(tag: unknown): string {
  return normalizeVoiceLocale(tag).split("-")[0];
}

/** English language name for the agent context ("Spanish (Mexico)"). */
export function voiceLanguageName(tag: unknown): string {
  const canonical = normalizeVoiceLocale(tag);
  const hit = VOICE_LOCALES.find((l) => l.tag === canonical);
  return (hit ?? VOICE_LOCALES[0]).language;
}
