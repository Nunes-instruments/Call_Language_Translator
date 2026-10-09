import { describe, expect, it } from "vitest";
import { decideCallLanguage } from "./callLanguageDecision";
import { normalizeSarvamLanguage } from "./sarvamLanguageAdapter";
import { runOfflineLanguagePipeline } from "./offlineLanguagePipeline";

function run(languageCode: string | null) {
  return runOfflineLanguagePipeline(
    "session-102",
    "customer-102",
    "staff-102",
    languageCode === null ? null : { language_code: languageCode }
  );
}

describe("Offline Tamil Hindi routing regression", () => {
  it("bypasses Tamil customer and Tamil staff", () => {
    expect(decideCallLanguage("ta-IN", "ta-IN")).toEqual({
      mode: "bypass",
      reason: "SAME_LANGUAGE"
    });
  });

  it("defaults staff language to Tamil", () => {
    expect(decideCallLanguage("ta-IN").mode).toBe("bypass");
  });

  it("selects Hindi customer to Tamil staff translation", () => {
    expect(decideCallLanguage("hi-IN", "ta-IN")).toEqual({
      mode: "translate",
      customerTarget: "ta-IN",
      staffTarget: "hi-IN"
    });
  });

  it("holds unknown customer language", () => {
    expect(decideCallLanguage("unknown").mode).toBe("hold");
  });

  it("holds unknown staff language", () => {
    expect(decideCallLanguage("hi-IN", "unknown").mode).toBe("hold");
  });

  it("holds unsupported Hindi to Hindi pairing", () => {
    expect(decideCallLanguage("hi-IN", "hi-IN").mode).toBe("hold");
  });

  it("normalizes Tamil language variants", () => {
    for (const value of ["ta", "ta_IN", "tamil", " TA-IN "]) {
      expect(normalizeSarvamLanguage({ language_code: value }))
        .toBe("ta-IN");
    }
  });

  it("normalizes Hindi language variants", () => {
    for (const value of ["hi", "hi_IN", "hindi", " HI-IN "]) {
      expect(normalizeSarvamLanguage({ language_code: value }))
        .toBe("hi-IN");
    }
  });

  it("holds unsupported English and missing detection", () => {
    expect(run("en-IN").decision.mode).toBe("hold");
    expect(run(null).decision.mode).toBe("hold");
  });

  it("never activates live audio or external Sarvam calls", () => {
    for (const language of ["ta-IN", "hi-IN", "en-IN"]) {
      const result = run(language);

      expect(result.simulationOnly).toBe(true);
      expect(result.translationEnabled).toBe(false);
      expect(result.audioIsolationVerified).toBe(false);
      expect(result.liveAudioEnabled).toBe(false);
      expect(result.sarvamApiCalled).toBe(false);
    }
  });
});