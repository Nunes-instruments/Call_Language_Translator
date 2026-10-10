import { describe, expect, it, vi } from "vitest";
import { TwoLegAudioCoordinator } from "./twoLegAudioCoordinator";
import { CrossLegAudioDispatcher } from "./crossLegAudioDispatcher";

describe("Cross-leg audio safety", () => {
  it("blocks playback while isolation is unverified", () => {
    const coordinator = new TwoLegAudioCoordinator();
    coordinator.create("s1", "customer1", "staff1");
    coordinator.attachStream("s1", "customer", "stream1");
    coordinator.attachStream("s1", "staff", "stream2");

    const dispatcher = new CrossLegAudioDispatcher(coordinator);
    const send = vi.fn();

    dispatcher.register("stream2", {
      readyState: 1,
      send
    });

    expect(dispatcher.dispatch("s1", "customer", "YXVkaW8="))
      .toEqual({
        delivered: false,
        reason: "TRANSLATION_DISABLED"
      });

    expect(send).not.toHaveBeenCalled();
  });

  it("rejects unknown sessions", () => {
    const coordinator = new TwoLegAudioCoordinator();
    const dispatcher = new CrossLegAudioDispatcher(coordinator);

    expect(dispatcher.dispatch("missing", "staff", "YXVkaW8="))
      .toEqual({
        delivered: false,
        reason: "UNKNOWN_SESSION"
      });
  });

  it("rejects missing stream IDs", () => {
    const coordinator = new TwoLegAudioCoordinator();
    const dispatcher = new CrossLegAudioDispatcher(coordinator);

    expect(() => dispatcher.register("", {
      readyState: 1,
      send: vi.fn()
    })).toThrow();
  });
});
