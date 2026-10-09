import { describe, expect, it } from "vitest";
import { assessAudioIsolation } from "./audioIsolationContract";

describe("Audio isolation safety contract", () => {
  it("fails when no evidence is supplied", () => {
    const result = assessAudioIsolation({});
    expect(result.passed).toBe(false);
    expect(result.missing).toHaveLength(6);
  });

  it("fails if original audio can cross the bridge", () => {
    const result = assessAudioIsolation({
      customerLegIsolated: true,
      staffLegIsolated: true,
      originalAudioNotCrossBridged: false,
      customerPlaybackVerified: true,
      staffPlaybackVerified: true,
      disconnectCleanupVerified: true
    });

    expect(result.passed).toBe(false);
    expect(result.missing).toContain(
      "originalAudioNotCrossBridged"
    );
  });

  it("requires both playback directions", () => {
    const result = assessAudioIsolation({
      customerLegIsolated: true,
      staffLegIsolated: true,
      originalAudioNotCrossBridged: true,
      customerPlaybackVerified: true,
      staffPlaybackVerified: false,
      disconnectCleanupVerified: true
    });

    expect(result.passed).toBe(false);
  });

  it("requires disconnect cleanup", () => {
    const result = assessAudioIsolation({
      customerLegIsolated: true,
      staffLegIsolated: true,
      originalAudioNotCrossBridged: true,
      customerPlaybackVerified: true,
      staffPlaybackVerified: true,
      disconnectCleanupVerified: false
    });

    expect(result.passed).toBe(false);
  });

  it("assesses complete evidence without authorizing production", () => {
    const result = assessAudioIsolation({
      customerLegIsolated: true,
      staffLegIsolated: true,
      originalAudioNotCrossBridged: true,
      customerPlaybackVerified: true,
      staffPlaybackVerified: true,
      disconnectCleanupVerified: true
    });

    expect(result.passed).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.productionActivationAllowed).toBe(false);
  });

  it("never treats missing fields as verified", () => {
    const result = assessAudioIsolation({
      customerLegIsolated: true
    });

    expect(result.passed).toBe(false);
    expect(result.productionActivationAllowed).toBe(false);
  });
});
