import { describe, expect, it } from "vitest";
import { CallLifecycleManager } from "./callLifecycleManager";

const connected = {
  sessionId: "session-1",
  customerUuid: "customer-uuid",
  staffUuid: "staff-uuid",
  status: "connected"
};

describe("CallLifecycleManager", () => {
  it("registers a connected two-leg call", () => {
    const manager = new CallLifecycleManager();

    expect(manager.register(connected)).toBe(true);
    expect(manager.get("session-1")?.customer.callUuid)
      .toBe("customer-uuid");
    expect(manager.get("session-1")?.staff.callUuid)
      .toBe("staff-uuid");
  });

  it("ignores duplicate callbacks", () => {
    const manager = new CallLifecycleManager();

    expect(manager.register(connected)).toBe(true);
    expect(manager.register(connected)).toBe(false);
  });

  it("rejects incomplete call identifiers", () => {
    const manager = new CallLifecycleManager();

    expect(manager.register({
      ...connected,
      customerUuid: ""
    })).toBe(false);
  });

  it("ignores non-connected call status", () => {
    const manager = new CallLifecycleManager();

    expect(manager.register({
      ...connected,
      status: "ringing"
    })).toBe(false);

    expect(manager.get("session-1")).toBeUndefined();
  });

  it("cleans up completed calls", () => {
    const manager = new CallLifecycleManager();

    manager.register(connected);
    manager.complete("session-1");

    expect(manager.get("session-1")).toBeUndefined();
    expect(manager.isCompleted("session-1")).toBe(true);
  });

  it("prevents completed sessions from reopening", () => {
    const manager = new CallLifecycleManager();

    manager.register(connected);
    manager.complete("session-1");

    expect(manager.register(connected)).toBe(false);
  });
});
