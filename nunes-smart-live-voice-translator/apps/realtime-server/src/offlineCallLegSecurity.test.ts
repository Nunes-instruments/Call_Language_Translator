import { describe, expect, it, vi } from "vitest";
import { OfflineCallCleanupController } from "./offlineCallCleanupController";

function socket() {
  return {
    readyState: 1,
    send: vi.fn()
  };
}

function setup() {
  const controller = new OfflineCallCleanupController();

  controller.create(
    "security-session",
    "customer-uuid",
    "staff-uuid"
  );

  return controller;
}

describe("Offline independent call-leg security", () => {
  it("rejects identical customer and staff UUIDs", () => {
    const controller = new OfflineCallCleanupController();

    expect(() =>
      controller.create("invalid", "same-uuid", "same-uuid")
    ).toThrow();
  });

  it("keeps customer and staff call UUIDs separate", () => {
    const controller = setup();
    const session = controller.coordinator.get("security-session");

    expect(session?.customer.callUuid).toBe("customer-uuid");
    expect(session?.staff.callUuid).toBe("staff-uuid");
  });

  it("rejects duplicate stream IDs between call legs", () => {
    const controller = setup();

    controller.attach(
      "security-session",
      "customer",
      "shared-stream",
      socket()
    );

    expect(() =>
      controller.attach(
        "security-session",
        "staff",
        "shared-stream",
        socket()
      )
    ).toThrow();
  });

  it("rejects replacing an active stream without disconnect", () => {
    const controller = setup();

    controller.attach(
      "security-session",
      "customer",
      "stream-1",
      socket()
    );

    expect(() =>
      controller.attach(
        "security-session",
        "customer",
        "stream-2",
        socket()
      )
    ).toThrow();
  });

  it("ignores disconnect events from the wrong socket", () => {
    const controller = setup();
    const owner = socket();

    controller.attach(
      "security-session",
      "customer",
      "customer-stream",
      owner
    );

    controller.disconnect(
      "security-session",
      "customer",
      "customer-stream",
      socket()
    );

    expect(
      controller.coordinator.get("security-session")?.customer.connected
    ).toBe(true);
  });

  it("disconnects the matching socket safely", () => {
    const controller = setup();
    const owner = socket();

    controller.attach(
      "security-session",
      "customer",
      "customer-stream",
      owner
    );

    controller.disconnect(
      "security-session",
      "customer",
      "customer-stream",
      owner
    );

    expect(
      controller.coordinator.get("security-session")?.customer.connected
    ).toBe(false);
  });

  it("keeps translation disabled when both legs connect", () => {
    const controller = setup();

    controller.attach(
      "security-session",
      "customer",
      "customer-stream",
      socket()
    );

    controller.attach(
      "security-session",
      "staff",
      "staff-stream",
      socket()
    );

    expect(
      controller.coordinator.get("security-session")?.translationEnabled
    ).toBe(false);

    expect(() =>
      controller.coordinator.setTranslationEnabled(
        "security-session",
        true
      )
    ).toThrow();
  });

  it("removes session state when the call completes", () => {
    const controller = setup();

    controller.attach(
      "security-session",
      "customer",
      "customer-stream",
      socket()
    );

    controller.attach(
      "security-session",
      "staff",
      "staff-stream",
      socket()
    );

    controller.complete("security-session");

    expect(
      controller.coordinator.get("security-session")
    ).toBeUndefined();
  });

  it("ignores stale disconnect after call completion", () => {
    const controller = setup();
    const owner = socket();

    controller.attach(
      "security-session",
      "customer",
      "customer-stream",
      owner
    );

    controller.complete("security-session");

    expect(() =>
      controller.disconnect(
        "security-session",
        "customer",
        "customer-stream",
        owner
      )
    ).not.toThrow();
  });

  it("blocks playback when translation is disabled", () => {
    const controller = setup();
    const customer = socket();
    const staff = socket();

    controller.attach(
      "security-session",
      "customer",
      "customer-stream",
      customer
    );

    controller.attach(
      "security-session",
      "staff",
      "staff-stream",
      staff
    );

    const result = controller.dispatcher.dispatch(
      "security-session",
      "customer",
      "offline-audio"
    );

    expect(result.delivered).toBe(false);
    expect(customer.send).not.toHaveBeenCalled();
    expect(staff.send).not.toHaveBeenCalled();
  });
});