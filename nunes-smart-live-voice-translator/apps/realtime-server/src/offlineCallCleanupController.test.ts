import { describe, expect, it, vi } from "vitest";
import { OfflineCallCleanupController } from "./offlineCallCleanupController";

describe("Offline automatic two-leg cleanup", () => {
  function setup() {
    const controller = new OfflineCallCleanupController();

    controller.create("session-1", "customer-1", "staff-1");

    const customerSocket = { readyState: 1, send: vi.fn() };
    const staffSocket = { readyState: 1, send: vi.fn() };

    controller.attach(
      "session-1", "customer", "stream-c", customerSocket
    );

    controller.attach(
      "session-1", "staff", "stream-s", staffSocket
    );

    return { controller, customerSocket, staffSocket };
  }

  it("disconnects customer without disconnecting staff", () => {
    const { controller, customerSocket } = setup();

    controller.disconnect(
      "session-1", "customer", "stream-c", customerSocket
    );

    const session = controller.coordinator.get("session-1");

    expect(session?.customer.connected).toBe(false);
    expect(session?.staff.connected).toBe(true);
    expect(session?.translationEnabled).toBe(false);
  });

  it("disconnects staff without disconnecting customer", () => {
    const { controller, staffSocket } = setup();

    controller.disconnect(
      "session-1", "staff", "stream-s", staffSocket
    );

    const session = controller.coordinator.get("session-1");

    expect(session?.staff.connected).toBe(false);
    expect(session?.customer.connected).toBe(true);
  });

  it("ignores stale disconnect after reconnect", () => {
    const { controller, customerSocket } = setup();

    controller.disconnect(
      "session-1", "customer", "stream-c", customerSocket
    );

    const replacement = { readyState: 1, send: vi.fn() };

    controller.attach(
      "session-1", "customer", "stream-new", replacement
    );

    controller.disconnect(
      "session-1", "customer", "stream-c", customerSocket
    );

    expect(
      controller.coordinator.get("session-1")?.customer.streamId
    ).toBe("stream-new");
  });

  it("blocks translated playback", () => {
    const { controller, staffSocket } = setup();

    const result = controller.dispatcher.dispatch(
      "session-1", "customer", "YXVkaW8="
    );

    expect(result).toEqual({
      delivered: false,
      reason: "TRANSLATION_DISABLED"
    });

    expect(staffSocket.send).not.toHaveBeenCalled();
  });

  it("removes completed session", () => {
    const { controller } = setup();

    controller.complete("session-1");

    expect(controller.coordinator.get("session-1")).toBeUndefined();
  });

  it("keeps translation activation blocked", () => {
    const { controller } = setup();

    expect(() =>
      controller.coordinator.setTranslationEnabled("session-1", true)
    ).toThrow();
  });
});