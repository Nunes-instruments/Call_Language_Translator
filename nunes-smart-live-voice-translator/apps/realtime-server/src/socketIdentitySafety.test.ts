import { describe, expect, it, vi } from "vitest";
import { TwoLegAudioCoordinator } from "./twoLegAudioCoordinator";
import { CrossLegAudioDispatcher } from "./crossLegAudioDispatcher";

describe("WebSocket identity safety", () => {
  function setup() {
    const coordinator = new TwoLegAudioCoordinator();
    const dispatcher = new CrossLegAudioDispatcher(coordinator);

    const socketA = {
      readyState: 1,
      send: vi.fn()
    };

    const socketB = {
      readyState: 1,
      send: vi.fn()
    };

    return { dispatcher, socketA, socketB };
  }

  it("rejects replacing an active socket for the same stream", () => {
    const { dispatcher, socketA, socketB } = setup();

    dispatcher.register("stream-1", socketA);

    expect(() =>
      dispatcher.register("stream-1", socketB)
    ).toThrow();
  });

  it("allows idempotent registration of the same socket", () => {
    const { dispatcher, socketA } = setup();

    dispatcher.register("stream-2", socketA);

    expect(() =>
      dispatcher.register("stream-2", socketA)
    ).not.toThrow();
  });

  it("ignores stale unregister from a different socket", () => {
    const { dispatcher, socketA, socketB } = setup();

    dispatcher.register("stream-3", socketA);

    dispatcher.unregister("stream-3", socketB);

    expect(() =>
      dispatcher.register("stream-3", socketB)
    ).toThrow();
  });

  it("allows registration after matching socket unregister", () => {
    const { dispatcher, socketA, socketB } = setup();

    dispatcher.register("stream-4", socketA);
    dispatcher.unregister("stream-4", socketA);

    expect(() =>
      dispatcher.register("stream-4", socketB)
    ).not.toThrow();
  });

  it("rejects blank stream identifiers", () => {
    const { dispatcher, socketA } = setup();

    expect(() =>
      dispatcher.register("   ", socketA)
    ).toThrow();
  });
});
