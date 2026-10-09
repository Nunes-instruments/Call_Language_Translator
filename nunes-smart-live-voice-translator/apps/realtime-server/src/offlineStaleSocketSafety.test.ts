import { describe, expect, it, vi } from "vitest";
import { OfflineCallCleanupController } from "./offlineCallCleanupController";

describe("Offline stale WebSocket disconnect safety", () => {
  function socket() {
    return { readyState: 1, send: vi.fn() };
  }

  it("ignores disconnect from a socket that does not own the active stream", () => {
    const controller = new OfflineCallCleanupController();
    const activeSocket = socket();
    const staleSocket = socket();

    controller.create("s1", "customer-1", "staff-1");
    controller.attach("s1", "customer", "stream-c", activeSocket);

    controller.disconnect("s1", "customer", "stream-c", staleSocket);

    expect(controller.coordinator.get("s1")?.customer.connected).toBe(true);
    expect(controller.coordinator.get("s1")?.customer.streamId).toBe("stream-c");

    expect(() =>
      controller.attach("s1", "staff", "stream-c", socket())
    ).toThrow();
  });

  it("disconnects when the matching socket owns the stream", () => {
    const controller = new OfflineCallCleanupController();
    const activeSocket = socket();

    controller.create("s1", "customer-1", "staff-1");
    controller.attach("s1", "customer", "stream-c", activeSocket);

    controller.disconnect("s1", "customer", "stream-c", activeSocket);

    expect(controller.coordinator.get("s1")?.customer.connected).toBe(false);

    expect(() =>
      controller.attach("s1", "customer", "stream-c", socket())
    ).not.toThrow();
  });
});