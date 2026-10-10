import { describe, expect, it } from "vitest";
import { runOfflineLanguagePipeline } from "./offlineLanguagePipeline";

function run(language_code?: string) {
  return runOfflineLanguagePipeline(
    "session-1",
    "customer-1",
    "staff-1",
    language_code ? { language_code } : {}
  );
}

describe("Offline language detection pipeline", () => {
  it("bypasses Tamil-to-Tamil", () => {
    const result = run("ta-IN");

    expect(result.detectedLanguage).toBe("ta-IN");
    expect(result.decision.mode).toBe("bypass");
  });

  it("selects Hindi-to-Tamil translation", () => {
    const result = run("hi-IN");

    expect(result.decision).toEqual({
      mode: "translate",
      customerTarget: "ta-IN",
      staffTarget: "hi-IN"
    });
  });

  it("holds unknown language", () => {
    expect(run().decision.mode).toBe("hold");
  });

  it("holds unsupported English language", () => {
    expect(run("en-IN").decision.mode).toBe("hold");
  });

  it("normalizes Sarvam language code", () => {
    expect(run("hi_IN").detectedLanguage).toBe("hi-IN");
  });

  it("never activates real audio translation", () => {
    const result = run("hi-IN");

    expect(result.simulationOnly).toBe(true);
    expect(result.translationEnabled).toBe(false);
    expect(result.audioIsolationVerified).toBe(false);
    expect(result.liveAudioEnabled).toBe(false);
    expect(result.sarvamApiCalled).toBe(false);
  });

  it("rejects identical call UUIDs", () => {
    expect(() =>
      runOfflineLanguagePipeline(
        "session-2", "same", "same",
        { language_code: "hi-IN" }
      )
    ).toThrow();
  });

  it("holds null detection results", () => {
    const result = runOfflineLanguagePipeline(
      "session-3", "customer-3", "staff-3", null
    );

    expect(result.decision.mode).toBe("hold");
  });
});
