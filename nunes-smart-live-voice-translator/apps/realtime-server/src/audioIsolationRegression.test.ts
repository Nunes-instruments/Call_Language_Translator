import { describe, expect, it, vi } from "vitest";
import { TwoLegAudioCoordinator } from "./twoLegAudioCoordinator";
import { CrossLegAudioDispatcher } from "./crossLegAudioDispatcher";

function setup() {
  const coordinator = new TwoLegAudioCoordinator();

  coordinator.create("session", "customer", "staff");
  coordinator.attachStream("session", "customer", "stream-c");
  coordinator.attachStream("session", "staff", "stream-s");

  const dispatcher = new CrossLegAudioDispatcher(coordinator);

  const customerSend = vi.fn();
  const staffSend = vi.fn();

  dispatcher.register("stream-c", {
    readyState: 1,
    send: customerSend
  });

  dispatcher.register("stream-s", {
    readyState: 1,
    send: staffSend
  });

  return {
    coordinator,
    dispatcher,
    customerSend,
    staffSend
  };
}

describe("Audio isolation regression safety", () => {
  it("blocks customer audio playback", () => {
    const s = setup();

    const result = s.dispatcher.dispatch(
      "session", "customer", "YXVkaW8="
    );

    expect(result.delivered).toBe(false);
    expect(s.customerSend).not.toHaveBeenCalled();
    expect(s.staffSend).not.toHaveBeenCalled();
  });

  it("blocks staff audio playback", () => {
    const s = setup();

    const result = s.dispatcher.dispatch(
      "session", "staff", "YXVkaW8="
    );

    expect(result.delivered).toBe(false);
    expect(s.customerSend).not.toHaveBeenCalled();
    expect(s.staffSend).not.toHaveBeenCalled();
  });

  it("rejects translation activation", () => {
    const s = setup();

    expect(() =>
      s.coordinator.setTranslationEnabled("session", true)
    ).toThrow(/isolation/i);

    expect(
      s.coordinator.get("session")?.translationEnabled
    ).toBe(false);
  });

  it("blocks playback after customer disconnect", () => {
    const s = setup();

    s.coordinator.detachStream("session", "customer");

    expect(
      s.dispatcher.dispatch("session", "staff", "YXVkaW8=")
        .delivered
    ).toBe(false);

    expect(s.customerSend).not.toHaveBeenCalled();
    expect(s.staffSend).not.toHaveBeenCalled();
  });

  it("blocks playback after staff disconnect", () => {
    const s = setup();

    s.coordinator.detachStream("session", "staff");

    expect(
      s.dispatcher.dispatch("session", "customer", "YXVkaW8=")
        .delivered
    ).toBe(false);

    expect(s.customerSend).not.toHaveBeenCalled();
    expect(s.staffSend).not.toHaveBeenCalled();
  });

  it("blocks playback after session removal", () => {
    const s = setup();

    s.coordinator.remove("session");

    expect(
      s.dispatcher.dispatch("session", "customer", "YXVkaW8=")
    ).toEqual({
      delivered: false,
      reason: "UNKNOWN_SESSION"
    });

    expect(s.customerSend).not.toHaveBeenCalled();
    expect(s.staffSend).not.toHaveBeenCalled();
  });
});
