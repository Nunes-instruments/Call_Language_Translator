import { createHmac } from "node:crypto";
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import { describe, expect, it, vi } from "vitest";
import { registerIndependentCallRoutes } from "./independentCallRoutes.js";
import { IndependentLiveCallManager } from "./independentLiveCallManager.js";
import { externalCallbackUrl, callbackParams, guardLegacyStreamUpgrade, createLegacyStreamStartGuard, signedRequestParams } from "./plivoCallbackRequest.js";
import { verifyPlivoWebhookSignature } from "./plivoWebhookSignature.js";
import { SignedIndependentCallCallbacks } from "./signedIndependentCallCallbacks.js";

const token = "offline-only-token";
const nonce = "offline-nonce";
// Independent fixture generator for the installed SDK 4.79.0 canonicalization.
// GET parameters already present in the URL must not be passed again.
function sign(method: string, url: string, body: Record<string, string | string[]> = {}, requestNonce = nonce) {
  const parsed = new URL(url);
  const entries = [...parsed.searchParams.entries()].sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0);
  const query = entries.map(([key, value]) => `${key}=${value}`).join("&");
  let canonical = parsed.origin + parsed.pathname;
  const hasBody = method === "POST" && Object.keys(body).length > 0;
  if (query || hasBody) canonical += "?" + query;
  if (query && hasBody) canonical += ".";
  if (hasBody) canonical += Object.keys(body).sort().map(key => (Array.isArray(body[key]) ? [...body[key]].sort() : [body[key]]).map(value => key + value).join("")).join("");
  return createHmac("sha256", token).update(canonical + "." + requestNonce).digest("base64");
}
const headers = (signature: string, requestNonce = nonce) => ({ "x-plivo-signature-v3": signature, "x-plivo-signature-v3-nonce": requestNonce });

describe("Plivo SDK canonicalization and callback boundaries", () => {
  it("uses only the method-specific provider parameter source", () => {
    expect(signedRequestParams({ method: "GET", query: { CallUUID: "signed" }, body: { CallUUID: "spoofed" } })).toEqual({ CallUUID: "signed" });
    expect(signedRequestParams({ method: "POST", query: { CallUUID: "spoofed" }, body: { CallUUID: "signed" } })).toEqual({ CallUUID: "signed" });
  });
  it("rejects unknown, malformed and repeated stream starts before provider setup", async () => {
    const known = vi.fn(async (callId: string) => callId === "known");
    const accept = createLegacyStreamStartGuard(known);
    expect(await accept(undefined)).toBe(false);
    expect(await accept({ callId: "known", streamId: " " })).toBe(false);
    expect(known).not.toHaveBeenCalled();
    const first = accept({ callId: "known", streamId: "stream" });
    expect(await accept({ callId: "known", streamId: "other" })).toBe(false);
    expect(await first).toBe(true);
    expect(known).toHaveBeenCalledTimes(1);
    expect(await createLegacyStreamStartGuard(known)({ callId: "unknown", streamId: "stream" })).toBe(false);
    expect(await createLegacyStreamStartGuard(async () => { throw new Error("DB unavailable"); })({ callId: "known", streamId: "stream" })).toBe(false);
  });
  for (const method of ["GET", "POST"]) {
    it(`verifies ${method} query and duplicate values without double counting`, () => {
      const url = "https://example.com/callback?z=2&a=b&a=a";
      const params: Record<string, string> = method === "POST" ? { CallUUID: "call", To: "+123" } : {};
      const signature = sign(method, url, params);
      const verify = (changedUrl = url, changedParams = params) => verifyPlivoWebhookSignature({ method, url: changedUrl, params: changedParams, nonce, signature, authToken: token }).valid;
      expect(verify()).toBe(true);
      expect(verify(url.replace("z=2", "z=3"))).toBe(false);
      expect(verify(url.replace("/callback", "/other"))).toBe(false);
      expect(verify(url + "&a=c")).toBe(false);
      if (method === "POST") expect(verify(url, { ...params, CallUUID: "other" })).toBe(false);
    });
  }
  it("rejects duplicate application parameters and untrusted URL origins", () => {
    expect(() => callbackParams({ CallUUID: ["one", "two"] })).toThrow();
    for (const url of ["https://evil.example/callback", "//evil.example/callback", "/wrong", "/callback#fragment"]) {
      expect(() => externalCallbackUrl("https://trusted.example", url, "/callback")).toThrow();
    }
    expect(externalCallbackUrl("https://trusted.example", "/callback?a=1", "/callback")).toBe("https://trusted.example/callback?a=1");
  });
  it("accepts real POST form identity and rejects tampering without mutation", async () => {
    const app = Fastify();
    await app.register(formbody);
    const manager = new IndependentLiveCallManager();
    const first = manager.create({ customerNumber: "1", staffNumber: "2" });
    const second = manager.create({ customerNumber: "3", staffNumber: "4" });
    manager.expectRequest(first.sessionId, "customer", "request-1");
    manager.expectRequest(second.sessionId, "customer", "request-2");
    await registerIndependentCallRoutes(app, { manager, publicBaseUrl: "https://example.com", authToken: token });
    const path = (action: string, sessionId = first.sessionId) => `/plivo/independent/${action}?sessionId=${sessionId}&role=customer`;
    let requestCounter = 0;
    const post = (target: string, body: Record<string, string>, signedTarget = target, signedBody = body) => {
      const requestNonce = `offline-request-${++requestCounter}`;
      const requestUuid = target.includes(second.sessionId) ? "request-2" : "request-1";
      const payload = { RequestUUID: requestUuid, ...body };
      return app.inject({
        method: "POST", url: target, headers: { ...headers(sign("POST", "https://example.com" + signedTarget, { RequestUUID: requestUuid, ...signedBody }, requestNonce), requestNonce), "content-type": "application/x-www-form-urlencoded", host: "evil.example", "x-forwarded-host": "evil.example" }, payload: new URLSearchParams(payload).toString(),
      });
    };
    try {
      expect((await post(path("answered"), { CallUUID: "call-1" })).statusCode).toBe(200);
      expect((await post(path("stream-started"), { CallUUID: "call-1", StreamID: "stream-1" })).statusCode).toBe(200);
      expect((await post(path("stream-stopped"), { CallUUID: "wrong", StreamID: "stream-1" })).statusCode).toBe(403);
      expect(manager.getSession(first.sessionId)?.customer.streamId).toBe("stream-1");
      expect((await post(path("answered", second.sessionId), { CallUUID: "call-1" })).statusCode).toBe(403);
      expect((await post(path("completed", second.sessionId), { CallUUID: "call-1" }, path("completed"))).statusCode).toBe(403);
      expect((await post(path("completed"), { CallUUID: "changed" }, path("completed"), { CallUUID: "call-1" })).statusCode).toBe(403);
      expect((await post(path("stream-started"), { CallUUID: "call-1", streamId: "wrong-case" })).statusCode).toBe(403);
      expect((await post(path("answered"), { CallUUID: "call-1", role: "customer" })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: path("completed"), payload: { CallUUID: "call-1" } })).statusCode).toBe(403);
      expect((await post(path("stream-stopped"), { CallUUID: "call-1", StreamID: "stream-1" })).statusCode).toBe(200);
      expect((await post(path("completed"), { CallUUID: "call-1" })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
  it("accepts signed GET callbacks and rejects duplicate query identities", async () => {
    const app = Fastify();
    const manager = new IndependentLiveCallManager();
    const session = manager.create({ customerNumber: "1", staffNumber: "2" });
    await registerIndependentCallRoutes(app, { manager, publicBaseUrl: "https://example.com", authToken: token });
    manager.expectRequest(session.sessionId, "staff", "staff-request");
    const url = `/plivo/independent/answered?sessionId=${session.sessionId}&role=staff&CallUUID=staff-call&RequestUUID=staff-request`;
    try {
      expect((await app.inject({ url, headers: headers(sign("GET", "https://example.com" + url)) })).statusCode).toBe(200);
      const duplicate = url + "&role=staff";
      expect((await app.inject({ url: duplicate, headers: headers(sign("GET", "https://example.com" + duplicate)) })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
  it("binds stream ID at the callback API boundary", () => {
    const manager = new IndependentLiveCallManager();
    const session = manager.create({ customerNumber: "1", staffNumber: "2" });
    manager.expectRequest(session.sessionId, "customer", "request");
    manager.registerCall(session.sessionId, "customer", "call");
    const callbackUrl = `https://example.com/callback?sessionId=${session.sessionId}&role=customer`;
    const params = { CallUUID: "call", StreamID: "signed-stream" };
    const callbacks = new SignedIndependentCallCallbacks(manager);
    const input = { sessionId: session.sessionId, role: "customer" as const, callUuid: "call", streamId: "spoofed-stream", webhook: { method: "POST", callbackUrl, params, authToken: token, headers: headers(sign("POST", callbackUrl, params)) } };
    expect(() => callbacks.streamStarted(input)).toThrow();
    expect(() => callbacks.streamStopped(input)).toThrow();
    expect(manager.getSession(session.sessionId)?.customer.streamId).toBeNull();
  });
  it("blocks unsigned upgrades and independent sessions on the legacy stream", async () => {
    const app = Fastify();
    app.get("/plivo/stream", {
      preValidation: async (request, reply) => {
        if (!guardLegacyStreamUpgrade(request, "https://example.com", token)) return reply.code(403).send();
      },
    }, async () => "authorized");
    try {
      expect((await app.inject({ url: "/plivo/stream" })).statusCode).toBe(403);
      const url = "/plivo/stream?tag=original";
      const signedHeaders = headers(sign("GET", "https://example.com" + url));
      expect((await app.inject({ url, headers: { ...signedHeaders, host: "evil.example" } })).statusCode).toBe(200);
      expect((await app.inject({ url: url.replace("original", "changed"), headers: signedHeaders })).statusCode).toBe(403);
      const independent = "/plivo/stream?sessionId=some-session&role=customer";
      expect((await app.inject({ url: independent, headers: headers(sign("GET", "https://example.com" + independent)) })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
});
