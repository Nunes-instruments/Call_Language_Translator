import { describe, expect, it } from "vitest";
import {
  createIsolatedTestSession,
  activateIsolatedTestTranslation
} from "./isolatedTestSession";

describe("Isolated test session", () => {
  it("creates a simulation-only session", () => {
    const session = createIsolatedTestSession(
      "test-session",
      "customer-uuid",
      "staff-uuid"
    );

    expect(session.mode).toBe("simulation");
    expect(session.translationEnabled).toBe(false);
    expect(session.audioIsolationVerified).toBe(false);
  });

  it("rejects identical call legs", () => {
    expect(() =>
      createIsolatedTestSession("test", "same", "same")
    ).toThrow(/different/i);
  });

  it("rejects missing identifiers", () => {
    expect(() =>
      createIsolatedTestSession("", "customer", "staff")
    ).toThrow(/required/i);
  });

  it("always blocks live translation", () => {
    const session = createIsolatedTestSession(
      "test",
      "customer",
      "staff"
    );

    expect(() =>
      activateIsolatedTestTranslation(session)
    ).toThrow(/blocked/i);
  });
});
