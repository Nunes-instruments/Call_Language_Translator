import { describe, expect, it } from "vitest";
import { OfflineTwoLegOrchestrator } from "./offlineTwoLegOrchestrator";

describe("Offline stream identity safety", () => {
  const url = "wss://example.test/plivo/stream";

  it("rejects duplicate stream IDs across call legs", () => {
    const o = new OfflineTwoLegOrchestrator();

    o.create("s1", "customer-1", "staff-1", url);
    o.attach("s1", "customer", "shared-stream");

    expect(() =>
      o.attach("s1", "staff", "shared-stream")
    ).toThrow();

    expect(o.get("s1")?.staff.connected).toBe(false);
  });

  it("rejects replacing an active stream without disconnect", () => {
    const o = new OfflineTwoLegOrchestrator();

    o.create("s2", "customer-2", "staff-2", url);
    o.attach("s2", "customer", "stream-original");

    expect(() =>
      o.attach("s2", "customer", "stream-replacement")
    ).toThrow();

    expect(o.get("s2")?.customer.streamId).toBe(
      "stream-original"
    );
  });

  it("rejects attaching a stream to an unknown session", () => {
    const o = new OfflineTwoLegOrchestrator();

    expect(() =>
      o.attach("missing-session", "customer", "stream-1")
    ).toThrow();
  });

  it("keeps translation disabled after reconnect", () => {
    const o = new OfflineTwoLegOrchestrator();

    o.create("s4", "customer-4", "staff-4", url);

    o.attach("s4", "customer", "stream-old");
    o.attach("s4", "staff", "staff-stream");

    o.detach("s4", "customer");
    o.attach("s4", "customer", "stream-new");

    expect(o.get("s4")?.translationEnabled).toBe(false);
    expect(o.get("s4")?.customer.streamId).toBe(
      "stream-new"
    );
  });

  it("rejects empty stream IDs", () => {
    const o = new OfflineTwoLegOrchestrator();

    o.create("s5", "customer-5", "staff-5", url);

    expect(() =>
      o.attach("s5", "customer", "")
    ).toThrow();
  });

  it("rejects duplicate session IDs", () => {
    const o = new OfflineTwoLegOrchestrator();

    o.create("s6", "customer-6", "staff-6", url);

    expect(() =>
      o.create("s6", "customer-new", "staff-new", url)
    ).toThrow();
  });
});
