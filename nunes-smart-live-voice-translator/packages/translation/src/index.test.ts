import { describe, expect, it } from "vitest";
import {
  protectEntities,
  restoreEntities,
  verifyEntityIntegrity
} from "./index";

describe("NUNES Translation Entity Protection", () => {

  it("protects pressure calibrator", () => {
    const result = protectEntities(
      "मुझे pressure calibrator चाहिए।"
    );

    expect(result.text).not.toContain("pressure calibrator");

    const restored = restoreEntities(
      result.text,
      result.entities
    );

    expect(restored).toContain("pressure calibrator");
  });

  it("preserves price GST and percentage", () => {
    const original =
      "Fluke pressure calibrator कीमत ₹25,000 plus 18% GST है।";

    const protectedResult = protectEntities(original);

    const restored = restoreEntities(
      protectedResult.text,
      protectedResult.entities
    );

    expect(restored).toContain("Fluke");
    expect(restored).toContain("pressure calibrator");
    expect(restored).toContain("₹25,000");
    expect(restored).toContain("18%");
    expect(restored).toContain("GST");
  });

  it("preserves model standards and units", () => {
    const original =
      "GE Druck DPI 620G ASTM 4-20 mA";

    const protectedResult = protectEntities(original);

    const restored = restoreEntities(
      protectedResult.text,
      protectedResult.entities
    );

    expect(restored).toContain("GE Druck");
    expect(restored).toContain("DPI 620G");
    expect(restored).toContain("ASTM");
    expect(restored).toContain("4-20 mA");

    const integrity = verifyEntityIntegrity(
      restored,
      protectedResult.entities
    );

    expect(integrity.valid).toBe(true);
  });

  it("detects missing protected entities", () => {
    const protectedResult = protectEntities(
      "Fluke pressure calibrator ₹25,000"
    );

    const integrity = verifyEntityIntegrity(
      "இந்த மொழிபெயர்ப்பில் protected terms இல்லை",
      protectedResult.entities
    );

    expect(integrity.valid).toBe(false);
    expect(integrity.missing.length).toBeGreaterThan(0);
  });

});
