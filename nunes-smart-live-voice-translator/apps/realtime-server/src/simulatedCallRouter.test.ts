import { describe, expect, it } from "vitest";
import { simulateCallRouting } from "./simulatedCallRouter";

describe("Simulated call routing integration", () => {
  it("selects bypass for Tamil customer and Tamil staff", () => {
    const result = simulateCallRouting(
      "call-1", "customer-1", "staff-1", "ta-IN"
    );

    expect(result.decision.mode).toBe("bypass");
    expect(result.translationEnabled).toBe(false);
  });

  it("selects Hindi-to-Tamil and Tamil-to-Hindi targets", () => {
    const result = simulateCallRouting(
      "call-2", "customer-2", "staff-2", "hi-IN"
    );

    expect(result.decision).toEqual({
      mode: "translate",
      customerTarget: "ta-IN",
      staffTarget: "hi-IN"
    });

    expect(result.translationEnabled).toBe(false);
  });

  it("holds unknown customer language", () => {
    const result = simulateCallRouting(
      "call-3", "customer-3", "staff-3", "unknown"
    );

    expect(result.decision.mode).toBe("hold");
  });

  it("holds unknown staff language", () => {
    const result = simulateCallRouting(
      "call-4", "customer-4", "staff-4",
      "hi-IN", "unknown"
    );

    expect(result.decision.mode).toBe("hold");
  });

  it("rejects identical call legs", () => {
    expect(() =>
      simulateCallRouting("call-5", "same", "same", "hi-IN")
    ).toThrow(/different/i);
  });

  it("never enables live translation", () => {
    const result = simulateCallRouting(
      "call-6", "customer-6", "staff-6", "hi-IN"
    );

    expect(result.simulationOnly).toBe(true);
    expect(result.translationEnabled).toBe(false);
    expect(result.audioIsolationVerified).toBe(false);
  });
});
