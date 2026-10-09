import { validateV3Signature } from "plivo";

export type PlivoSignatureInput = {
  method: string;
  url: string;
  nonce?: string;
  signature?: string;
  authToken?: string;
  params?: Record<string, string | string[]>;
};

export type PlivoSignatureResult =
  | { valid: true }
  | {
      valid: false;
      reason:
        | "MISSING_METHOD"
        | "INVALID_URL"
        | "MISSING_NONCE"
        | "MISSING_SIGNATURE"
        | "MISSING_AUTH_TOKEN"
        | "INVALID_SIGNATURE";
    };

/**
 * Offline reusable validator.
 *
 * IMPORTANT:
 * - URL must be the exact externally visible callback URL.
 * - Use the actual request method.
 * - Do not reconstruct URL from untrusted forwarded headers.
 * - This module is not wired into production routes.
 */
export function verifyPlivoWebhookSignature(
  input: PlivoSignatureInput
): PlivoSignatureResult {
  const method = input.method?.trim().toUpperCase();

  if (method !== "GET" && method !== "POST") {
    return { valid: false, reason: "MISSING_METHOD" };
  }

  let url: URL;

  try {
    url = new URL(input.url);
  } catch {
    return { valid: false, reason: "INVALID_URL" };
  }

  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  ) {
    return { valid: false, reason: "INVALID_URL" };
  }

  if (!input.nonce?.trim()) {
    return { valid: false, reason: "MISSING_NONCE" };
  }

  if (!input.signature?.trim()) {
    return { valid: false, reason: "MISSING_SIGNATURE" };
  }

  if (!input.authToken?.trim()) {
    return { valid: false, reason: "MISSING_AUTH_TOKEN" };
  }

  try {
    const valid = validateV3Signature(
      method,
      input.url,
      input.nonce,
      input.authToken,
      input.signature,
      input.params ?? {}
    );

    return valid
      ? { valid: true }
      : { valid: false, reason: "INVALID_SIGNATURE" };
  } catch {
    return { valid: false, reason: "INVALID_SIGNATURE" };
  }
}