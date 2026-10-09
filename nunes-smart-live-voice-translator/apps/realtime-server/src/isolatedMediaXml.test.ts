import { describe, expect, it } from "vitest";
import { buildIsolatedMediaXml } from "./isolatedMediaXml";

describe("Offline isolated media XML", () => {
  const url = "wss://example.test/plivo/stream";

  it("builds customer stream XML", () => {
    const xml = buildIsolatedMediaXml("customer", url);

    expect(xml).toContain('bidirectional="true"');
    expect(xml).toContain('keepCallAlive="true"');
    expect(xml).toContain("leg=customer");
    expect(xml).not.toContain("<Dial");
  });

  it("builds staff stream XML", () => {
    const xml = buildIsolatedMediaXml("staff", url);

    expect(xml).toContain("leg=staff");
    expect(xml).not.toContain("<Dial");
  });

  it("requires secure WebSocket", () => {
    expect(() =>
      buildIsolatedMediaXml("customer", "ws://example.test")
    ).toThrow();
  });

  it("escapes XML special characters", () => {
    const xml = buildIsolatedMediaXml(
      "customer",
      "wss://example.test/stream?token=a&value=b"
    );

    expect(xml).toContain("&amp;");
    expect(xml).not.toContain("token=a&value");
  });

  it("does not contain direct audio bridge", () => {
    const xml = buildIsolatedMediaXml("customer", url);

    expect(xml).not.toContain("<Number>");
    expect(xml).not.toContain("<Dial>");
    expect(xml).not.toContain("<Conference");
  });
});
