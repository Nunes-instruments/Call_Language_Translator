import { describe, expect, it } from "vitest";
import { TwoLegAudioCoordinator } from "./twoLegAudioCoordinator";

describe("TwoLegAudioCoordinator", () => {
  it("creates separate customer and staff legs", () => {
    const coordinator = new TwoLegAudioCoordinator();
    const session = coordinator.create("s1", "customer-uuid", "staff-uuid");

    expect(session.customer.callUuid).toBe("customer-uuid");
    expect(session.staff.callUuid).toBe("staff-uuid");
    expect(session.translationEnabled).toBe(false);
  });

  it("rejects duplicate call UUIDs", () => {
    const coordinator = new TwoLegAudioCoordinator();

    expect(() =>
      coordinator.create("s1", "same-uuid", "same-uuid")
    ).toThrow();
  });

  it("routes customer audio destination to staff", () => {
    const coordinator = new TwoLegAudioCoordinator();
    coordinator.create("s1", "customer-uuid", "staff-uuid");
    coordinator.attachStream("s1", "staff", "staff-stream");

    expect(coordinator.getDestination("s1", "customer")?.streamId)
      .toBe("staff-stream");
  });

  it("routes staff audio destination to customer", () => {
    const coordinator = new TwoLegAudioCoordinator();
    coordinator.create("s1", "customer-uuid", "staff-uuid");
    coordinator.attachStream("s1", "customer", "customer-stream");

    expect(coordinator.getDestination("s1", "staff")?.streamId)
      .toBe("customer-stream");
  });

  it("does not route to disconnected legs", () => {
    const coordinator = new TwoLegAudioCoordinator();
    coordinator.create("s1", "customer-uuid", "staff-uuid");

    expect(coordinator.getDestination("s1", "customer")).toBeNull();
  });

  it("blocks translation before audio isolation verification", () => {
    const coordinator = new TwoLegAudioCoordinator();
    coordinator.create("s1", "customer-uuid", "staff-uuid");

    expect(() =>
      coordinator.setTranslationEnabled("s1", true)
    ).toThrow(/audio isolation/i);
  });

  it("detaches streams safely", () => {
    const coordinator = new TwoLegAudioCoordinator();
    coordinator.create("s1", "customer-uuid", "staff-uuid");
    coordinator.attachStream("s1", "staff", "staff-stream");
    coordinator.detachStream("s1", "staff");

    expect(coordinator.getDestination("s1", "customer")).toBeNull();
  });

  it("removes completed sessions", () => {
    const coordinator = new TwoLegAudioCoordinator();
    coordinator.create("s1", "customer-uuid", "staff-uuid");
    coordinator.remove("s1");

    expect(coordinator.get("s1")).toBeUndefined();
  });
});
