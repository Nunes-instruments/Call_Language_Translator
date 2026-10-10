import {
  verifyPlivoWebhookSignature,
} from "./plivoWebhookSignature.js";

export interface PlivoWebhookRequestInput {
  method: string;
  callbackUrl: string;
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, string | string[]>;
  authToken?: string;
}

export interface PlivoWebhookGuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Validates a Plivo HTTP callback before any call-leg mutation.
 *
 * callbackUrl must come from trusted server configuration.
 * Never construct it from request Host or X-Forwarded-* headers.
 *
 * This module is not yet registered on production routes.
 */
export function guardPlivoWebhookRequest(
  input: PlivoWebhookRequestInput
): PlivoWebhookGuardResult {
  const normalizedHeaders = new Map<string, string>();

  for (const [key, value] of Object.entries(input.headers)) {
    if (Array.isArray(value)) {
      return {
        allowed: false,
        reason: "AMBIGUOUS_HEADER",
      };
    }

    if (typeof value === "string") {
      const normalized = key.toLowerCase();

      if (normalizedHeaders.has(normalized)) {
        return {
          allowed: false,
          reason: "DUPLICATE_HEADER",
        };
      }

      normalizedHeaders.set(normalized, value);
    }
  }

  const signature = normalizedHeaders.get(
    "x-plivo-signature-v3"
  );

  const nonce = normalizedHeaders.get(
    "x-plivo-signature-v3-nonce"
  );

  const result = verifyPlivoWebhookSignature({
    method: input.method,
    url: input.callbackUrl,
    nonce,
    signature,
    authToken: input.authToken,
    params: input.params,
  });

  return result.valid
    ? { allowed: true }
    : {
        allowed: false,
        reason: result.reason,
      };
}