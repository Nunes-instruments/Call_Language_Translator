import { createHmac, randomUUID } from "node:crypto";

/** Independent ASCII fixture signer for the actual installed Plivo 4.79.0 V3 algorithm. */
export function offlineSignature(method: string, callbackUrl: string, params: Record<string, string>, token: string, nonce: string): string {
  const url = new URL(callbackUrl);
  const entries = [...url.searchParams].sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0);
  const query = entries.map(([key, value]) => `${key}=${value}`).join("&");
  const hasBody = method === "POST" && Object.keys(params).length > 0;
  let canonical = url.origin + url.pathname;
  if (query || hasBody) canonical += "?" + query;
  if (query && hasBody) canonical += ".";
  if (hasBody) canonical += Object.keys(params).sort().map(key => key + params[key]).join("");
  return createHmac("sha256", token).update(canonical + "." + nonce).digest("base64");
}
export function offlineHeaders(method: string, url: string, params: Record<string, string>, token: string, nonce: string = randomUUID()) {
  return { "x-plivo-signature-v3": offlineSignature(method, url, params, token, nonce), "x-plivo-signature-v3-nonce": nonce };
}
