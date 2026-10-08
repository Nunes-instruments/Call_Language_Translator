import { describe, expect, it } from "vitest";
import { getTranslationTestMode } from "./translationTestMode";

describe("Translation test mode safety", () => {
  it("is disabled by default", () => {
    const result = getTranslationTestMode({});
    expect(result.allowLiveTranslation).toBe(false);
  });

  it("cannot activate unverified translation", () => {
    const result = getTranslationTestMode({
      NUNES_TRANSLATION_TEST_MODE: "true"
    });

    expect(result.enabled).toBe(true);
    expect(result.audioIsolationVerified).toBe(false);
    expect(result.allowLiveTranslation).toBe(false);
  });

  it("rejects unrelated environment settings", () => {
    const result = getTranslationTestMode({
      NODE_ENV: "production"
    });

    expect(result.enabled).toBe(false);
    expect(result.allowLiveTranslation).toBe(false);
  });
});
