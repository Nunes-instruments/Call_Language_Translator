import { describe, expect, it, vi } from "vitest";
import { OfflineCallCleanupController } from "./offlineCallCleanupController";

describe("Offline session socket cleanup regression", () => {
  function socket() {
    return { readyState: 1, send: vi.fn() };
  }

  it("releases customer socket identity on session completion", () => {
    const controller = new OfflineCallCleanupController();
    const original = socket();

    controller.create("s1", "customer-1", "staff-1");
    controller.attach("s1", "customer", "stream-c", original);
    controller.complete("s1");

    controller.create("s2", "customer-2", "staff-2");

    expect(() =>
      controller.attach("s2", "customer", "stream-c", socket())
    ).not.toThrow();
  });

  it("releases staff socket identity on session completion", () => {
    const controller = new OfflineCallCleanupController();

    controller.create("s1", "customer-1", "staff-1");
    controller.attach("s1", "staff", "stream-s", socket());
    controller.complete("s1");

    controller.create("s2", "customer-2", "staff-2");

    expect(() =>
      controller.attach("s2", "staff", "stream-s", socket())
    ).not.toThrow();
  });

  it("releases both stream identities on completion", () => {
    const controller = new OfflineCallCleanupController();

    controller.create("s1", "customer-1", "staff-1");
    controller.attach("s1", "customer", "stream-c", socket());
    controller.attach("s1", "staff", "stream-s", socket());

    controller.complete("s1");

    controller.create("s2", "customer-2", "staff-2");

    expect(() =>
      controller.attach("s2", "customer", "stream-c", socket())
    ).not.toThrow();

    expect(() =>
      controller.attach("s2", "staff", "stream-s", socket())
    ).not.toThrow();
  });

  it("allows repeated completion without throwing", () => {
    const controller = new OfflineCallCleanupController();

    controller.create("s1", "customer-1", "staff-1");
    controller.attach("s1", "customer", "stream-c", socket());

    controller.complete("s1");

    expect(() => controller.complete("s1")).not.toThrow();
  });

  it("never enables translation during cleanup", () => {
    const controller = new OfflineCallCleanupController();

    controller.create("s1", "customer-1", "staff-1");
    controller.attach("s1", "customer", "stream-c", socket());

    expect(
      controller.coordinator.get("s1")?.translationEnabled
    ).toBe(false);

    controller.complete("s1");

    expect(controller.coordinator.get("s1")).toBeUndefined();
  });
});