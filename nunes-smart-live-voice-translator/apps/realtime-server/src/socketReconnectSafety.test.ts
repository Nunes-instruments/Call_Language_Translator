import { describe, expect, it, vi } from "vitest";
import { TwoLegAudioCoordinator } from "./twoLegAudioCoordinator";
import { CrossLegAudioDispatcher } from "./crossLegAudioDispatcher";

describe("WebSocket reconnect lifecycle safety", () => {
  function setup() {
    const coordinator = new TwoLegAudioCoordinator();
    const dispatcher = new CrossLegAudioDispatcher(coordinator);
    const socketA = { readyState: 1, send: vi.fn() };
    const socketB = { readyState: 1, send: vi.fn() };
    return { dispatcher, socketA, socketB };
  }

  it("rejects assigning one active socket to two stream IDs", () => {
    const { dispatcher, socketA } = setup();
    dispatcher.register("stream-a", socketA);
    expect(() => dispatcher.register("stream-b", socketA)).toThrow();
  });

  it("permits socket reuse after matching unregister", () => {
    const { dispatcher, socketA } = setup();
    dispatcher.register("stream-a", socketA);
    dispatcher.unregister("stream-a", socketA);
    expect(() => dispatcher.register("stream-b", socketA)).not.toThrow();
  });

  it("does not allow stale socket to remove replacement", () => {
    const { dispatcher, socketA, socketB } = setup();
    dispatcher.register("stream-a", socketA);
    dispatcher.unregister("stream-a", socketA);
    dispatcher.register("stream-a", socketB);
    dispatcher.unregister("stream-a", socketA);
    expect(() => dispatcher.register("stream-a", socketA)).toThrow();
  });

  it("allows new socket after proper cleanup", () => {
    const { dispatcher, socketA, socketB } = setup();
    dispatcher.register("stream-a", socketA);
    dispatcher.unregister("stream-a", socketA);
    expect(() => dispatcher.register("stream-a", socketB)).not.toThrow();
  });

  it("rejects replacing an active stream socket", () => {
    const { dispatcher, socketA, socketB } = setup();
    dispatcher.register("stream-a", socketA);
    expect(() => dispatcher.register("stream-a", socketB)).toThrow();
  });
});