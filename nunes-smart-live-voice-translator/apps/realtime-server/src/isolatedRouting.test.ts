import { describe, expect, it } from "vitest";
import { TwoLegAudioCoordinator } from "./twoLegAudioCoordinator";
import { getTranslationTestMode } from "./translationTestMode";

describe("Isolated two-leg routing safety", () => {
  it("routes customer destination to staff", () => {
    const coordinator = new TwoLegAudioCoordinator();

    coordinator.create("session-1", "customer-1", "staff-1");
    coordinator.attachStream("session-1", "staff", "stream-staff");

    const destination = coordinator.getDestination(
      "session-1",
      "customer"
    );

    expect(destination?.callUuid).toBe("staff-1");
    expect(destination?.streamId).toBe("stream-staff");
  });

  it("routes staff destination to customer", () => {
    const coordinator = new TwoLegAudioCoordinator();

    coordinator.create("session-2", "customer-2", "staff-2");
    coordinator.attachStream("session-2", "customer", "stream-customer");

    const destination = coordinator.getDestination(
      "session-2",
      "staff"
    );

    expect(destination?.callUuid).toBe("customer-2");
    expect(destination?.streamId).toBe("stream-customer");
  });

  it("blocks routing when destination is disconnected", () => {
    const coordinator = new TwoLegAudioCoordinator();

    coordinator.create("session-3", "customer-3", "staff-3");

    expect(
      coordinator.getDestination("session-3", "customer")
    ).toBeNull();
  });

  it("blocks live translation without verified isolation", () => {
    const mode = getTranslationTestMode({
      NUNES_TRANSLATION_TEST_MODE: "true"
    });

    expect(mode.allowLiveTranslation).toBe(false);
  });

  it("rejects premature translation activation", () => {
    const coordinator = new TwoLegAudioCoordinator();

    coordinator.create("session-4", "customer-4", "staff-4");

    expect(() =>
      coordinator.setTranslationEnabled("session-4", true)
    ).toThrow();
  });
});
