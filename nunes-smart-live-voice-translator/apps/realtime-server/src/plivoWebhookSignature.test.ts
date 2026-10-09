import { describe, expect, it, vi } from "vitest";

vi.mock("plivo", () => ({
  validateV3Signature: vi.fn()
}));

import { validateV3Signature } from "plivo";
import { verifyPlivoWebhookSignature } from "./plivoWebhookSignature";

const mockedValidator = vi.mocked(validateV3Signature);

const validInput = {
  method: "POST",
  url: "https://example.com/plivo/status",
  nonce: "test-nonce",
  signature: "test-signature",
  authToken: "test-auth-token"
};

describe("Offline Plivo webhook signature verification", () => {
  it("accepts a signature approved by the SDK", () => {
    mockedValidator.mockReturnValueOnce(true);

    expect(
      verifyPlivoWebhookSignature(validInput)
    ).toEqual({ valid: true });
  });

  it("rejects a signature rejected by the SDK", () => {
    mockedValidator.mockReturnValueOnce(false);

    expect(
      verifyPlivoWebhookSignature(validInput)
    ).toEqual({
      valid: false,
      reason: "INVALID_SIGNATURE"
    });
  });

  it("rejects a missing nonce", () => {
    expect(
      verifyPlivoWebhookSignature({
        ...validInput,
        nonce: ""
      })
    ).toEqual({
      valid: false,
      reason: "MISSING_NONCE"
    });
  });

  it("rejects a missing signature", () => {
    expect(
      verifyPlivoWebhookSignature({
        ...validInput,
        signature: ""
      })
    ).toEqual({
      valid: false,
      reason: "MISSING_SIGNATURE"
    });
  });

  it("rejects a missing auth token", () => {
    expect(
      verifyPlivoWebhookSignature({
        ...validInput,
        authToken: ""
      })
    ).toEqual({
      valid: false,
      reason: "MISSING_AUTH_TOKEN"
    });
  });

  it("rejects unsupported HTTP methods", () => {
    expect(
      verifyPlivoWebhookSignature({
        ...validInput,
        method: "DELETE"
      })
    ).toEqual({
      valid: false,
      reason: "MISSING_METHOD"
    });
  });

  it("rejects HTTP callback URLs", () => {
    expect(
      verifyPlivoWebhookSignature({
        ...validInput,
        url: "http://example.com/plivo/status"
      })
    ).toEqual({
      valid: false,
      reason: "INVALID_URL"
    });
  });

  it("rejects malformed URLs", () => {
    expect(
      verifyPlivoWebhookSignature({
        ...validInput,
        url: "not-a-url"
      })
    ).toEqual({
      valid: false,
      reason: "INVALID_URL"
    });
  });

  it("passes the exact method and URL to the SDK", () => {
    mockedValidator.mockReturnValueOnce(true);

    verifyPlivoWebhookSignature({
      ...validInput,
      method: "post"
    });

    expect(mockedValidator).toHaveBeenCalledWith(
      "POST",
      validInput.url,
      validInput.nonce,
      validInput.authToken,
      validInput.signature,
      {}
    );
  });

  it("fails closed when the SDK throws", () => {
    mockedValidator.mockImplementationOnce(() => {
      throw new Error("Verification failure");
    });

    expect(
      verifyPlivoWebhookSignature(validInput)
    ).toEqual({
      valid: false,
      reason: "INVALID_SIGNATURE"
    });
  });
});