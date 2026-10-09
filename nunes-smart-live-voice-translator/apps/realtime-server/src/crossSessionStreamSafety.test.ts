import { describe, expect, it } from "vitest";
import { OfflineTwoLegOrchestrator } from "./offlineTwoLegOrchestrator";

describe("Cross-session stream safety", () => {
  const url = "wss://example.test/plivo/stream";

  it("rejects one stream ID used by two sessions", () => {
    const o = new OfflineTwoLegOrchestrator();

    o.create("call-a", "customer-a", "staff-a", url);
    o.create("call-b", "customer-b", "staff-b", url);

    o.attach("call-a", "customer", "stream-shared");

    expect(() =>
      o.attach("call-b", "customer", "stream-shared")
    ).toThrow();

    expect(o.get("call-b")?.customer.connected).toBe(false);
  });

  it("allows distinct streams across sessions", () => {
    const o = new OfflineTwoLegOrchestrator();

    o.create("call-c", "customer-c", "staff-c", url);
    o.create("call-d", "customer-d", "staff-d", url);

    o.attach("call-c", "customer", "stream-c");
    o.attach("call-d", "customer", "stream-d");

    expect(o.get("call-c")?.customer.streamId).toBe("stream-c");
    expect(o.get("call-d")?.customer.streamId).toBe("stream-d");
  });

  it("releases stream identity after disconnect", () => {
    const o = new OfflineTwoLegOrchestrator();

    o.create("call-e", "customer-e", "staff-e", url);
    o.create("call-f", "customer-f", "staff-f", url);

    o.attach("call-e", "customer", "stream-reusable");
    o.detach("call-e", "customer");

    o.attach("call-f", "customer", "stream-reusable");

    expect(o.get("call-f")?.customer.streamId).toBe(
      "stream-reusable"
    );
  });

  it("rejects stream identity collision across roles", () => {
    const o = new OfflineTwoLegOrchestrator();

    o.create("call-g", "customer-g", "staff-g", url);
    o.create("call-h", "customer-h", "staff-h", url);

    o.attach("call-g", "staff", "stream-shared-role");

    expect(() =>
      o.attach("call-h", "customer", "stream-shared-role")
    ).toThrow();
  });

  it("keeps translation disabled in all sessions", () => {
    const o = new OfflineTwoLegOrchestrator();

    o.create("call-i", "customer-i", "staff-i", url);
    o.create("call-j", "customer-j", "staff-j", url);

    o.attach("call-i", "customer", "stream-i");
    o.attach("call-j", "staff", "stream-j");

    expect(o.get("call-i")?.translationEnabled).toBe(false);
    expect(o.get("call-j")?.translationEnabled).toBe(false);
  });
});
