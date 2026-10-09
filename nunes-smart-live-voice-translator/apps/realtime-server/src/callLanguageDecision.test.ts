import { describe, expect, it } from "vitest";
import { decideCallLanguage } from "./callLanguageDecision";

describe("Call language decision", () => {
  it("bypasses Tamil-to-Tamil calls", () => {
    expect(decideCallLanguage("ta-IN")).toEqual({
      mode: "bypass",
      reason: "SAME_LANGUAGE"
    });
  });

  it("translates Hindi customer to Tamil staff", () => {
    expect(decideCallLanguage("hi-IN")).toEqual({
      mode: "translate",
      customerTarget: "ta-IN",
      staffTarget: "hi-IN"
    });
  });

  it("holds unknown customer language", () => {
    expect(decideCallLanguage("unknown").mode).toBe("hold");
  });

  it("holds unknown staff language", () => {
    expect(decideCallLanguage("hi-IN", "unknown").mode)
      .toBe("hold");
  });

  it("does not translate when both speak Hindi", () => {
    expect(decideCallLanguage("hi-IN", "hi-IN").mode)
      .toBe("hold");
  });

  it("keeps staff language Tamil by default", () => {
    const decision = decideCallLanguage("hi-IN");

    expect(decision.mode).toBe("translate");

    if (decision.mode === "translate") {
      expect(decision.customerTarget).toBe("ta-IN");
    }
  });
});
