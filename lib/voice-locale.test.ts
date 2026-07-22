import { describe, expect, it } from "vitest";
import {
  VOICE_LOCALES,
  DEFAULT_VOICE_LOCALE,
  normalizeVoiceLocale,
  webSpeechLang,
  appleSpeechLocale,
  whisperLanguage,
  voiceLanguageName,
} from "./voice-locale";

describe("VOICE_LOCALES", () => {
  it("keeps English first so every fallback path lands on it", () => {
    expect(VOICE_LOCALES[0].tag).toBe("en-US");
    expect(DEFAULT_VOICE_LOCALE).toBe("en-US");
  });

  it("uses unique canonical BCP-47 tags", () => {
    const tags = VOICE_LOCALES.map((l) => l.tag);
    expect(new Set(tags).size).toBe(tags.length);
    for (const tag of tags) {
      expect(tag).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
    }
  });
});

describe("normalizeVoiceLocale", () => {
  it("passes curated tags through unchanged", () => {
    for (const { tag } of VOICE_LOCALES) {
      expect(normalizeVoiceLocale(tag)).toBe(tag);
    }
  });

  it("accepts engine round-trip forms (underscore, casing, padding)", () => {
    expect(normalizeVoiceLocale("es_MX")).toBe("es-MX");
    expect(normalizeVoiceLocale("ja_jp")).toBe("ja-JP");
    expect(normalizeVoiceLocale("PT-br")).toBe("pt-BR");
    expect(normalizeVoiceLocale("  de-DE  ")).toBe("de-DE");
  });

  it("falls back to the default for anything off the curated list", () => {
    expect(normalizeVoiceLocale("ko-KR")).toBe(DEFAULT_VOICE_LOCALE);
    expect(normalizeVoiceLocale("es")).toBe(DEFAULT_VOICE_LOCALE);
    expect(normalizeVoiceLocale("")).toBe(DEFAULT_VOICE_LOCALE);
    expect(normalizeVoiceLocale(undefined)).toBe(DEFAULT_VOICE_LOCALE);
    expect(normalizeVoiceLocale(null)).toBe(DEFAULT_VOICE_LOCALE);
    expect(normalizeVoiceLocale(42)).toBe(DEFAULT_VOICE_LOCALE);
  });
});

describe("engine formats", () => {
  it("web speech gets the BCP-47 tag as-is", () => {
    expect(webSpeechLang("es-MX")).toBe("es-MX");
    expect(webSpeechLang("bogus")).toBe("en-US");
  });

  it("the apple-speech helper gets the underscore form", () => {
    expect(appleSpeechLocale("en-US")).toBe("en_US");
    expect(appleSpeechLocale("es-MX")).toBe("es_MX");
    expect(appleSpeechLocale("bogus")).toBe("en_US");
  });

  it("whisper gets the bare two-letter code", () => {
    expect(whisperLanguage("en-US")).toBe("en");
    expect(whisperLanguage("pt-BR")).toBe("pt");
    expect(whisperLanguage("ja-JP")).toBe("ja");
    expect(whisperLanguage("bogus")).toBe("en");
  });
});

describe("voiceLanguageName", () => {
  it("names every curated language in English for the agent", () => {
    expect(voiceLanguageName("en-US")).toBe("English");
    expect(voiceLanguageName("es-MX")).toBe("Spanish (Mexico)");
    expect(voiceLanguageName("es-ES")).toBe("Spanish (Spain)");
    expect(voiceLanguageName("ja-JP")).toBe("Japanese");
  });

  it("falls back to English for junk", () => {
    expect(voiceLanguageName("xx-XX")).toBe("English");
    expect(voiceLanguageName(undefined)).toBe("English");
  });
});
