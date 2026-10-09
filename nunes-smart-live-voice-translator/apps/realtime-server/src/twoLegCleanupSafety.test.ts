import { describe, expect, it, vi } from "vitest";
import { TwoLegAudioCoordinator } from "./twoLegAudioCoordinator";
import { CrossLegAudioDispatcher } from "./crossLegAudioDispatcher";

describe("Two-leg disconnect and cleanup safety", () => {
  function setup() {
    const coordinator = new TwoLegAudioCoordinator();
    const dispatcher = new CrossLegAudioDispatcher(coordinator);

    coordinator.create("session-1", "customer-1", "staff-1");
    coordinator.attachStream("session-1", "customer", "stream-c");
    coordinator.attachStream("session-1", "staff", "stream-s");

    const customerSocket = { readyState: 1, send: vi.fn() };
    const staffSocket = { readyState: 1, send: vi.fn() };

    dispatcher.register("stream-c", customerSocket);
    dispatcher.register("stream-s", staffSocket);

    return {
      coordinator,
      dispatcher,
      customerSocket,
      staffSocket
    };
  }

  it("disconnects only the matching customer stream", () => {
    const { coordinator } = setup();

    coordinator.detachStream("session-1", "customer", "stream-c");

    expect(coordinator.get("session-1")?.customer.connected).toBe(false);
    expect(coordinator.get("session-1")?.staff.connected).toBe(true);
    expect(coordinator.get("session-1")?.translationEnabled).toBe(false);
  });

  it("disconnects only the matching staff stream", () => {
    const { coordinator } = setup();

    coordinator.detachStream("session-1", "staff", "stream-s");

    expect(coordinator.get("session-1")?.staff.connected).toBe(false);
    expect(coordinator.get("session-1")?.customer.connected).toBe(true);
    expect(coordinator.get("session-1")?.translationEnabled).toBe(false);
  });

  it("ignores stale customer disconnect after reconnect", () => {
    const { coordinator } = setup();

    coordinator.detachStream("session-1", "customer", "stream-c");
    coordinator.attachStream("session-1", "customer", "stream-new");

    coordinator.detachStream("session-1", "customer", "stream-c");

    expect(coordinator.get("session-1")?.customer.connected).toBe(true);
    expect(coordinator.get("session-1")?.customer.streamId).toBe("stream-new");
  });

  it("releases socket identity after matching cleanup", () => {
    const { dispatcher, customerSocket } = setup();

    dispatcher.unregister("stream-c", customerSocket);

    const replacement = { readyState: 1, send: vi.fn() };

    expect(() =>
      dispatcher.register("stream-c", replacement)
    ).not.toThrow();
  });

  it("preserves active socket against stale cleanup", () => {
    const { dispatcher, customerSocket } = setup();

    const staleSocket = { readyState: 1, send: vi.fn() };

    dispatcher.unregister("stream-c", staleSocket);

    expect(() =>
      dispatcher.register("stream-c", staleSocket)
    ).toThrow();

    dispatcher.unregister("stream-c", customerSocket);
  });

  it("removes completed session without enabling translation", () => {
    const { coordinator } = setup();

    coordinator.remove("session-1");

    expect(coordinator.get("session-1")).toBeUndefined();
  });

  it("blocks playback after session removal", () => {
    const { coordinator, dispatcher, staffSocket } = setup();

    coordinator.remove("session-1");

    expect(
      dispatcher.dispatch("session-1", "customer", "YXVkaW8=")
    ).toEqual({
      delivered: false,
      reason: "UNKNOWN_SESSION"
    });

    expect(staffSocket.send).not.toHaveBeenCalled();
  });

  it("keeps live translation activation blocked", () => {
    const { coordinator } = setup();

    expect(() =>
      coordinator.setTranslationEnabled("session-1", true)
    ).toThrow();

    expect(coordinator.get("session-1")?.translationEnabled).toBe(false);
  });
});