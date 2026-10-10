import { describe, expect, it, vi } from "vitest";
import { PlivoStreamAdapter } from "./plivoStreamAdapter";

describe("PlivoStreamAdapter", () => {
  const url = "wss://example.com/plivo/stream";

  it("requires a secure WebSocket URL", () => {
    const client = {
      calls: {
        stream: vi.fn(),
        stopAllStream: vi.fn()
      }
    };

    expect(() => new PlivoStreamAdapter(client, "ws://example.com"))
      .toThrow(/secure websocket/i);
  });

  it("starts bidirectional inbound audio streaming", async () => {
    const stream = vi.fn().mockResolvedValue({ success: true });

    const client = {
      calls: {
        stream,
        stopAllStream: vi.fn()
      }
    };

    const adapter = new PlivoStreamAdapter(client, url);

    await adapter.start("customer-uuid");

    expect(stream).toHaveBeenCalledWith(
      "customer-uuid",
      url,
      {
        bidirectional: true,
        audioTrack: "inbound",
        contentType: "audio/x-mulaw;rate=8000"
      }
    );
  });

  it("stops streams for a call", async () => {
    const stopAllStream = vi.fn().mockResolvedValue({ success: true });

    const client = {
      calls: {
        stream: vi.fn(),
        stopAllStream
      }
    };

    const adapter = new PlivoStreamAdapter(client, url);

    await adapter.stop("customer-uuid");

    expect(stopAllStream).toHaveBeenCalledWith("customer-uuid");
  });

  it("rejects missing call UUIDs", async () => {
    const client = {
      calls: {
        stream: vi.fn(),
        stopAllStream: vi.fn()
      }
    };

    const adapter = new PlivoStreamAdapter(client, url);

    await expect(adapter.start("")).rejects.toThrow(/call uuid/i);
    await expect(adapter.stop("")).rejects.toThrow(/call uuid/i);
  });

  it("propagates Plivo API errors", async () => {
    const client = {
      calls: {
        stream: vi.fn().mockRejectedValue(new Error("Plivo API failure")),
        stopAllStream: vi.fn()
      }
    };

    const adapter = new PlivoStreamAdapter(client, url);

    await expect(adapter.start("customer-uuid"))
      .rejects.toThrow("Plivo API failure");
  });
});
