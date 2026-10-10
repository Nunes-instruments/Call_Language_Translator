import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyPlivoWebhookSignature } from "./plivoWebhookSignature";

const authToken = "offline-test-auth-token";
const nonce = "offline-test-nonce";
const url = "https://example.com/plivo/status";

function sign(baseUrl: string): string {
  return createHmac("sha256", authToken)
    .update(`${baseUrl}.${nonce}`)
    .digest("base64");
}

describe("Real Plivo SDK parameter signature verification", () => {
  it("accepts GET with signed query parameters", () => {
    const params = { CallUUID: "call-123" };
    const signature = sign(`${url}?CallUUID=call-123`);

    expect(
      verifyPlivoWebhookSignature({
        method: "GET",
        url,
        nonce,
        signature,
        authToken,
        params,
      }).valid,
    ).toBe(true);
  });

  it("rejects GET when signed parameters are changed", () => {
    const signature = sign(`${url}?CallUUID=call-123`);

    expect(
      verifyPlivoWebhookSignature({
        method: "GET",
        url,
        nonce,
        signature,
        authToken,
        params: { CallUUID: "call-456" },
      }).valid,
    ).toBe(false);
  });

  it("accepts POST with signed form parameters", () => {
    const params = {
      CallStatus: "completed",
      CallUUID: "call-123",
    };

    const signature = sign(
      `${url}?CallStatuscompletedCallUUIDcall-123`,
    );

    expect(
      verifyPlivoWebhookSignature({
        method: "POST",
        url,
        nonce,
        signature,
        authToken,
        params,
      }).valid,
    ).toBe(true);
  });

  it("rejects POST when form parameters are changed", () => {
    const signature = sign(
      `${url}?CallStatuscompletedCallUUIDcall-123`,
    );

    expect(
      verifyPlivoWebhookSignature({
        method: "POST",
        url,
        nonce,
        signature,
        authToken,
        params: {
          CallStatus: "failed",
          CallUUID: "call-123",
        },
      }).valid,
    ).toBe(false);
  });

  it("accepts POST without form parameters", () => {
    expect(
      verifyPlivoWebhookSignature({
        method: "POST",
        url,
        nonce,
        signature: sign(url),
        authToken,
        params: {},
      }).valid,
    ).toBe(true);
  });
});