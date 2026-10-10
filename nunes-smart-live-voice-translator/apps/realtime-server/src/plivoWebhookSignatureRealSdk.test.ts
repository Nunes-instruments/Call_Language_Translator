import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateV3Signature } from "plivo";
import { verifyPlivoWebhookSignature } from "./plivoWebhookSignature";

const authToken = "offline-test-token";
const nonce = "offline-test-nonce";
const url = "https://example.com/plivo/status";

/**
 * These are offline cryptographic tests.
 * No production credentials or network requests are used.
 *
 * The expected signature is constructed independently of
 * the Plivo SDK validation function.
 */
function createTestSignature(
  callbackUrl: string,
  requestNonce: string,
  token: string
): string {
  return createHmac("sha256", token)
    .update(`${callbackUrl}.${requestNonce}`)
    .digest("base64");
}

describe("Real Plivo SDK V3 cryptographic verification", () => {
  it("accepts a valid independently generated signature", () => {
    const signature = createTestSignature(url, nonce, authToken);

    expect(
      validateV3Signature(
        "GET",
        url,
        nonce,
        authToken,
        signature
      )
    ).toBe(true);
  });

  it("rejects an invalid signature", () => {
    expect(
      validateV3Signature(
        "GET",
        url,
        nonce,
        authToken,
        "invalid-signature"
      )
    ).toBe(false);
  });

  it("rejects a signature with the wrong auth token", () => {
    const signature = createTestSignature(url, nonce, authToken);

    expect(
      validateV3Signature(
        "GET",
        url,
        nonce,
        "wrong-token",
        signature
      )
    ).toBe(false);
  });

  it("rejects a signature with the wrong nonce", () => {
    const signature = createTestSignature(url, nonce, authToken);

    expect(
      validateV3Signature(
        "GET",
        url,
        "wrong-nonce",
        authToken,
        signature
      )
    ).toBe(false);
  });

  it("rejects a signature for a different callback URL", () => {
    const signature = createTestSignature(url, nonce, authToken);

    expect(
      validateV3Signature(
        "GET",
        "https://example.com/plivo/inbound",
        nonce,
        authToken,
        signature
      )
    ).toBe(false);
  });

  it("accepts a valid signature through the NUNES wrapper", () => {
    const signature = createTestSignature(url, nonce, authToken);

    expect(
      verifyPlivoWebhookSignature({
        method: "GET",
        url,
        nonce,
        signature,
        authToken
      })
    ).toEqual({ valid: true });
  });

  it("rejects an invalid signature through the NUNES wrapper", () => {
    expect(
      verifyPlivoWebhookSignature({
        method: "GET",
        url,
        nonce,
        signature: "invalid-signature",
        authToken
      })
    ).toEqual({
      valid: false,
      reason: "INVALID_SIGNATURE"
    });
  });
});