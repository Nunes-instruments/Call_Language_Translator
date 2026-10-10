import { describe, expect, it } from "vitest";
import { OfflineTwoLegOrchestrator } from "./offlineTwoLegOrchestrator";

describe("Offline two-leg orchestration", () => {
  const url = "wss://example.test/plivo/stream";

  it("creates two isolated XML plans without dialing", () => {
    const orchestrator = new OfflineTwoLegOrchestrator();

    const result = orchestrator.create(
      "session-1",
      "customer-1",
      "staff-1",
      url
    );

    expect(result.mode).toBe("simulation");
    expect(result.audioIsolationVerified).toBe(false);
    expect(result.translationEnabled).toBe(false);
    expect(result.customerXml).toContain("leg=customer");
    expect(result.staffXml).toContain("leg=staff");
    expect(result.customerXml).not.toContain("<Dial");
    expect(result.staffXml).not.toContain("<Dial");
  });

  it("tracks customer and staff streams separately", () => {
    const orchestrator = new OfflineTwoLegOrchestrator();

    orchestrator.create("session-2", "c-2", "s-2", url);
    orchestrator.attach("session-2", "customer", "stream-c");
    orchestrator.attach("session-2", "staff", "stream-s");

    const session = orchestrator.get("session-2");

    expect(session?.customer.streamId).toBe("stream-c");
    expect(session?.staff.streamId).toBe("stream-s");
    expect(session?.translationEnabled).toBe(false);
  });

  it("blocks translation activation", () => {
    const orchestrator = new OfflineTwoLegOrchestrator();

    orchestrator.create("session-3", "c-3", "s-3", url);

    expect(() =>
      orchestrator.activateTranslation("session-3")
    ).toThrow("Translation activation blocked");

    expect(
      orchestrator.get("session-3")?.translationEnabled
    ).toBe(false);
  });

  it("disables translation when a stream disconnects", () => {
    const orchestrator = new OfflineTwoLegOrchestrator();

    orchestrator.create("session-4", "c-4", "s-4", url);
    orchestrator.attach("session-4", "customer", "stream-c");
    orchestrator.attach("session-4", "staff", "stream-s");

    const session = orchestrator.detach(
      "session-4",
      "customer"
    );

    expect(session?.customer.connected).toBe(false);
    expect(session?.customer.streamId).toBeNull();
    expect(session?.translationEnabled).toBe(false);
  });

  it("removes completed sessions", () => {
    const orchestrator = new OfflineTwoLegOrchestrator();

    orchestrator.create("session-5", "c-5", "s-5", url);
    orchestrator.complete("session-5");

    expect(orchestrator.get("session-5")).toBeUndefined();
  });

  it("rejects insecure websocket URLs", () => {
    const orchestrator = new OfflineTwoLegOrchestrator();

    expect(() =>
      orchestrator.create(
        "session-6",
        "c-6",
        "s-6",
        "ws://example.test/stream"
      )
    ).toThrow();

    expect(orchestrator.get("session-6")).toBeUndefined();
  });
});
