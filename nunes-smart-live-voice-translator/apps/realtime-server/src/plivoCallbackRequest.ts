import type { FastifyRequest } from "fastify";
import { guardPlivoWebhookRequest } from "./plivoWebhookRequestGuard.js";

export function externalCallbackUrl(baseUrl: string, requestUrl: string, expectedPath: string): string {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error("INVALID_PUBLIC_BASE_URL");
  }
  // Only origin-relative request targets are accepted. Host and forwarded headers are ignored.
  if (!requestUrl.startsWith("/") || requestUrl.startsWith("//") || requestUrl.includes("\\") || requestUrl.includes("#")) {
    throw new Error("INVALID_CALLBACK_URL");
  }
  const incoming = new URL(requestUrl, base.origin);
  if (incoming.origin !== base.origin || incoming.pathname !== expectedPath) throw new Error("INVALID_CALLBACK_PATH");
  return base.origin + requestUrl;
}

export function callbackParams(raw: unknown): Record<string, string> {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("INVALID_CALLBACK_PARAMS");
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    // Duplicate values are valid SDK inputs, but ambiguous application identities are rejected.
    if (typeof value !== "string") throw new Error("AMBIGUOUS_CALLBACK_PARAMETER");
    result[key] = value;
  }
  return result;
}

export function signedRequestParams(request: Pick<FastifyRequest, "method" | "query" | "body">) {
  return callbackParams(request.method === "GET" ? request.query : request.body);
}

export function guardLegacyStreamUpgrade(
  request: Pick<FastifyRequest, "url" | "headers">,
  publicBaseUrl: string,
  authToken: string | undefined,
): boolean {
  try {
    const callbackUrl = externalCallbackUrl(publicBaseUrl, request.url, "/plivo/stream");
    const verification = guardPlivoWebhookRequest({
      method: "GET", callbackUrl, headers: request.headers, params: {}, authToken,
    });
    const query = new URL(callbackUrl).searchParams;
    // Independent media attachment has no authenticated implementation on the legacy bridge.
    return verification.allowed && !query.has("sessionId") && !query.has("role");
  } catch {
    return false;
  }
}

export function createLegacyStreamStartGuard(isKnownCall: (callId: string) => Promise<boolean>) {
  let startReceived = false;
  return async (start: { callId?: string; streamId?: string } | undefined): Promise<boolean> => {
    if (startReceived || !start?.callId?.trim() || !start.streamId?.trim()) return false;
    // Reserve before awaiting the database so concurrent start events cannot both attach.
    startReceived = true;
    try { return await isKnownCall(start.callId); }
    catch { return false; }
  };
}
