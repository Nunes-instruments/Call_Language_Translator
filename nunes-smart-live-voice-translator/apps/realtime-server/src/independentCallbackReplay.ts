import { createHash } from "node:crypto";
import type { PlivoWebhookRequestInput } from "./plivoWebhookRequestGuard.js";

type CachedResponse = { status: number; body: string; contentType: string };
type Entry = { sessionId: string; digest: string; response?: CachedResponse };

/** No time-based eviction while an owning session exists; capacity exhaustion fails closed. */
export class IndependentCallbackReplay {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly capacity = 8192) {}

  claim(input: PlivoWebhookRequestInput, sessionId: string, upgrade = false): { nonce: string; cached?: CachedResponse } {
    const nonceHeaders = Object.entries(input.headers).filter(([key]) => key.toLowerCase() === "x-plivo-signature-v3-nonce");
    const nonce = nonceHeaders.length === 1 ? nonceHeaders[0][1] : undefined;
    if (typeof nonce !== "string" || !nonce.trim() || nonce.length > 256) throw new Error("INVALID_NONCE");
    const url = new URL(input.callbackUrl);
    const sorted = (entries: Array<[string, string]>) => entries.sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0);
    const body = Object.entries(input.params ?? {}).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(item => [key, item] as [string, string]));
    const digest = createHash("sha256").update(JSON.stringify([input.method.toUpperCase(), url.origin, url.pathname, sorted([...url.searchParams]), sorted(body), upgrade])).digest("hex");
    const previous = this.entries.get(nonce);
    if (previous) {
      if (upgrade || previous.digest !== digest || previous.sessionId !== sessionId || !previous.response) throw new Error("CALLBACK_REPLAY_REJECTED");
      return { nonce, cached: { ...previous.response } };
    }
    if (this.entries.size >= this.capacity) throw new Error("REPLAY_CAPACITY_EXCEEDED");
    this.entries.set(nonce, { sessionId, digest });
    return { nonce };
  }

  complete(nonce: string, response: CachedResponse): void {
    const entry = this.entries.get(nonce);
    if (entry) entry.response = { ...response };
  }
  forgetSession(sessionId: string): void {
    for (const [nonce, entry] of this.entries) if (entry.sessionId === sessionId) this.entries.delete(nonce);
  }
  get size(): number { return this.entries.size; }
}
