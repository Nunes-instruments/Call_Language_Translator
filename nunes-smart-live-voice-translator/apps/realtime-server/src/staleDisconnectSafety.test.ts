import { describe, expect, it } from "vitest";
import { OfflineTwoLegOrchestrator } from "./offlineTwoLegOrchestrator";

describe("Stale disconnect safety", () => {
  const url = "wss://example.test/plivo/stream";

  it("ignores an old disconnect after reconnection", () => {
    const o = new OfflineTwoLegOrchestrator();

    o.create("s1", "customer-1", "staff-1", url);

    o.attach("s1", "customer", "stream-old");
    o.detach("s1", "customer", "stream-old");

    o.attach("s1", "customer", "stream-new");

    o.detach("s1", "customer", "stream-old");

    expect(o.get("s1")?.customer.connected).toBe(true);
    expect(o.get("s1")?.customer.streamId).toBe("stream-new");
  });

  it("disconnects the matching active stream", () => {
    const o = new OfflineTwoLegOrchestrator();

    o.create("s2", "customer-2", "staff-2", url);
    o.attach("s2", "customer", "stream-current");

    o.detach("s2", "customer", "stream-current");

    expect(o.get("s2")?.customer.connected).toBe(false);
    expect(o.get("s2")?.customer.streamId).toBeNull();
  });

  it("does not disconnect the opposite leg", () => {
    const o = new OfflineTwoLegOrchestrator();

    o.create("s3", "customer-3", "staff-3", url);

    o.attach("s3", "customer", "customer-stream");
    o.attach("s3", "staff", "staff-stream");

    o.detach("s3", "customer", "customer-stream");

    expect(o.get("s3")?.staff.connected).toBe(true);
    expect(o.get("s3")?.staff.streamId).toBe("staff-stream");
  });

  it("does not release a new stream on stale disconnect", () => {
    const o = new OfflineTwoLegOrchestrator();

    o.create("s4", "customer-4", "staff-4", url);
    o.create("s5", "customer-5", "staff-5", url);

    o.attach("s4", "customer", "stream-old");
    o.detach("s4", "customer", "stream-old");

    o.attach("s4", "customer", "stream-new");
    o.detach("s4", "customer", "stream-old");

    expect(() =>
      o.attach("s5", "customer", "stream-new")
    ).toThrow();
  });

  it("keeps translation disabled after stale events", () => {
    const o = new OfflineTwoLegOrchestrator();

    o.create("s6", "customer-6", "staff-6", url);

    o.attach("s6", "customer", "stream-old");
    o.detach("s6", "customer", "stream-old");
    o.attach("s6", "customer", "stream-new");

    o.detach("s6", "customer", "stream-old");

    expect(o.get("s6")?.translationEnabled).toBe(false);
  });
});
