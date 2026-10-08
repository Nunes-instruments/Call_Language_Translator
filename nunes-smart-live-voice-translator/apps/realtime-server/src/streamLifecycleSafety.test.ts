import { describe, expect, it, vi } from "vitest";
import { TwoLegAudioCoordinator } from "./twoLegAudioCoordinator";
import { CrossLegAudioDispatcher } from "./crossLegAudioDispatcher";
import { getTranslationTestMode } from "./translationTestMode";

describe("Stream lifecycle and bypass safety", () => {
  it("disables translation when customer disconnects", () => {
    const coordinator = new TwoLegAudioCoordinator();

    coordinator.create("call-1", "customer-1", "staff-1");
    coordinator.attachStream("call-1", "customer", "stream-c");
    coordinator.attachStream("call-1", "staff", "stream-s");

    coordinator.detachStream("call-1", "customer");

    expect(coordinator.get("call-1")?.translationEnabled).toBe(false);
    expect(coordinator.get("call-1")?.customer.connected).toBe(false);
  });

  it("disables translation when staff disconnects", () => {
    const coordinator = new TwoLegAudioCoordinator();

    coordinator.create("call-2", "customer-2", "staff-2");
    coordinator.attachStream("call-2", "customer", "stream-c");
    coordinator.attachStream("call-2", "staff", "stream-s");

    coordinator.detachStream("call-2", "staff");

    expect(coordinator.get("call-2")?.translationEnabled).toBe(false);
    expect(coordinator.get("call-2")?.staff.connected).toBe(false);
  });

  it("blocks audio after stream disconnect", () => {
    const coordinator = new TwoLegAudioCoordinator();
    coordinator.create("call-3", "customer-3", "staff-3");
    coordinator.attachStream("call-3", "customer", "stream-c");
    coordinator.attachStream("call-3", "staff", "stream-s");

    const dispatcher = new CrossLegAudioDispatcher(coordinator);
    const send = vi.fn();

    dispatcher.register("stream-s", { readyState: 1, send });

    coordinator.detachStream("call-3", "staff");
    dispatcher.unregister("stream-s");

    const result = dispatcher.dispatch(
      "call-3",
      "customer",
      "YXVkaW8="
    );

    expect(result.delivered).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps Tamil-to-Tamil calls in direct bypass mode", () => {
    const coordinator = new TwoLegAudioCoordinator();

    coordinator.create("tamil-call", "customer-t", "staff-t");

    const mode = getTranslationTestMode({
      NUNES_TRANSLATION_TEST_MODE: "true"
    });

    expect(mode.allowLiveTranslation).toBe(false);
    expect(coordinator.get("tamil-call")?.translationEnabled).toBe(false);
  });

  it("cleans up completed call sessions", () => {
    const coordinator = new TwoLegAudioCoordinator();

    coordinator.create("completed", "customer-x", "staff-x");
    coordinator.remove("completed");

    expect(coordinator.get("completed")).toBeUndefined();
  });
});
