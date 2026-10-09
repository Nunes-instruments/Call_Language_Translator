import { describe, expect, it } from "vitest";
import {
  normalizeSarvamLanguage,
  decideFromSarvamLanguage
} from "./sarvamLanguageAdapter";

describe("Sarvam language adapter", () => {
  it("maps Tamil language code", () => {
    expect(normalizeSarvamLanguage({
      language_code: "ta-IN"
    })).toBe("ta-IN");
  });

  it("maps Hindi language code", () => {
    expect(normalizeSarvamLanguage({
      language_code: "hi-IN"
    })).toBe("hi-IN");
  });

  it("normalizes underscore format", () => {
    expect(normalizeSarvamLanguage({
      detected_language: "hi_IN"
    })).toBe("hi-IN");
  });

  it("accepts explicit Tamil language label", () => {
    expect(normalizeSarvamLanguage({
      language: "Tamil"
    })).toBe("ta-IN");
  });

  it("does not guess language from unsupported codes", () => {
    expect(normalizeSarvamLanguage({
      language_code: "en-IN"
    })).toBe("unknown");
  });

  it("holds missing detection results", () => {
    expect(decideFromSarvamLanguage({}).mode).toBe("hold");
  });

  it("selects Tamil bypass", () => {
    expect(decideFromSarvamLanguage({
      language_code: "ta-IN"
    }).mode).toBe("bypass");
  });

  it("selects Hindi translation targets", () => {
    expect(decideFromSarvamLanguage({
      language_code: "hi-IN"
    })).toEqual({
      mode: "translate",
      customerTarget: "ta-IN",
      staffTarget: "hi-IN"
    });
  });
});
