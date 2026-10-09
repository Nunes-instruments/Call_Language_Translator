import { describe, expect, it, vi } from "vitest";
import { OfflineCallCleanupController } from "./offlineCallCleanupController";

describe("Offline two-leg media routing contract", () => {
  function socket() {
    return {
      readyState: 1,
      send: vi.fn()
    };
  }

  function setup() {
    const controller = new OfflineCallCleanupController();
    const customerSocket = socket();
    const staffSocket = socket();

    controller.create("session-1", "customer-uuid", "staff-uuid");

    controller.attach(
      "session-1",
      "customer",
      "customer-stream",
      customerSocket
    );

    controller.attach(
      "session-1",
      "staff",
      "staff-stream",
      staffSocket
    );

    return { controller, customerSocket, staffSocket };
  }

  it("keeps customer and staff stream identities separate", () => {
    const { controller } = setup();
    const session = controller.coordinator.get("session-1");

    expect(session?.customer.streamId).toBe("customer-stream");
    expect(session?.staff.streamId).toBe("staff-stream");
    expect(session?.customer.streamId).not.toBe(session?.staff.streamId);
  });

  it("identifies staff as the opposite destination for customer", () => {
    const { controller } = setup();

    expect(controller.coordinator.opposite("customer")).toBe("staff");
  });

  it("identifies customer as the opposite destination for staff", () => {
    const { controller } = setup();

    expect(controller.coordinator.opposite("staff")).toBe("customer");
  });

  it("blocks customer translated playback without verified isolation", () => {
    const { controller, customerSocket, staffSocket } = setup();

    const result = controller.dispatcher.dispatch(
      "session-1",
      "customer",
      "offline-test-audio"
    );

    expect(result.delivered).toBe(false);
    expect(customerSocket.send).not.toHaveBeenCalled();
    expect(staffSocket.send).not.toHaveBeenCalled();
  });

  it("blocks staff translated playback without verified isolation", () => {
    const { controller, customerSocket, staffSocket } = setup();

    const result = controller.dispatcher.dispatch(
      "session-1",
      "staff",
      "offline-test-audio"
    );

    expect(result.delivered).toBe(false);
    expect(customerSocket.send).not.toHaveBeenCalled();
    expect(staffSocket.send).not.toHaveBeenCalled();
  });

  it("prevents enabling translation through the coordinator", () => {
    const { controller } = setup();

    expect(() =>
      controller.coordinator.setTranslationEnabled("session-1", true)
    ).toThrow();

    expect(
      controller.coordinator.get("session-1")?.translationEnabled
    ).toBe(false);
  });

  it("disables both playback directions after session completion", () => {
    const { controller, customerSocket, staffSocket } = setup();

    controller.complete("session-1");

    expect(
      controller.dispatcher.dispatch(
        "session-1",
        "customer",
        "offline-test-audio"
      ).delivered
    ).toBe(false);

    expect(
      controller.dispatcher.dispatch(
        "session-1",
        "staff",
        "offline-test-audio"
      ).delivered
    ).toBe(false);

    expect(customerSocket.send).not.toHaveBeenCalled();
    expect(staffSocket.send).not.toHaveBeenCalled();
  });
});