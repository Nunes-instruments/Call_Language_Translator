import { describe, expect, it } from "vitest";
import { IndependentCallbackReplay } from "./independentCallbackReplay.js";
import { IndependentCallOrchestrator } from "./independentCallOrchestrator.js";
import { OfflineIndependentCallProvider } from "./independentCallProvider.js";
import { IndependentLiveCallManager } from "./independentLiveCallManager.js";

const input = (nonce = "nonce", callbackUrl = "https://offline.example/callback?role=customer&sessionId=session") => ({
  method: "POST", callbackUrl, headers: { "x-plivo-signature-v3-nonce": nonce }, params: { CallUUID: "call" },
});
const response = { status: 200, body: "OK", contentType: "text/plain" };
describe("Bounded independent replay and lifecycle guards", () => {
  it("fails closed for in-flight or previously failed processing", () => {
    const replay = new IndependentCallbackReplay();
    replay.claim(input(), "session");
    expect(() => replay.claim(input(), "session")).toThrow("CALLBACK_REPLAY_REJECTED");
  });
  it("returns cached success only for identical canonical request and session", () => {
    const replay = new IndependentCallbackReplay();
    replay.claim(input(), "session"); replay.complete("nonce", response);
    expect(replay.claim(input(), "session").cached).toEqual(response);
    expect(() => replay.claim(input(), "other-session")).toThrow();
    expect(() => replay.claim({ ...input(), params: { CallUUID: "changed" } }, "session")).toThrow();
    expect(() => replay.claim({ ...input(), method: "GET" }, "session")).toThrow();
  });
  it("does not evict live nonces to accommodate capacity overflow", () => {
    const replay = new IndependentCallbackReplay(1);
    replay.claim(input(), "session"); replay.complete("nonce", response);
    expect(() => replay.claim(input("next"), "session")).toThrow("REPLAY_CAPACITY_EXCEEDED");
    expect(replay.claim(input(), "session").cached).toEqual(response);
    replay.forgetSession("session");
    expect(replay.size).toBe(0);
  });
  it("never reuses a WebSocket upgrade nonce", () => {
    const replay = new IndependentCallbackReplay();
    replay.claim(input(), "session", true);
    expect(() => replay.claim(input(), "session", true)).toThrow();
  });
  it("binds provider requests globally across sessions and roles", () => {
    const manager = new IndependentLiveCallManager();
    const first = manager.create({ customerNumber: "one", staffNumber: "two" });
    const second = manager.create({ customerNumber: "three", staffNumber: "four" });
    manager.expectRequest(first.sessionId, "customer", "request");
    expect(() => manager.expectRequest(first.sessionId, "staff", "request")).toThrow();
    expect(() => manager.expectRequest(second.sessionId, "customer", "request")).toThrow();
    expect(() => manager.expectRequest(first.sessionId, "customer", "different")).toThrow();
    manager.expectRequest(first.sessionId, "customer", "request");
  });
  it("tears down a late create result after cancellation and never creates the second leg", async () => {
    let resolveCreate!: (value: { requestUuid: string; message: string }) => void;
    const provider = new OfflineIndependentCallProvider();
    let creates = 0;
    provider.createLeg = async () => { creates++; return new Promise(resolve => { resolveCreate = resolve; }); };
    const service = new IndependentCallOrchestrator({ provider, publicBaseUrl: "https://offline.example", fromNumber: "+919876543210" });
    const creating = service.create({ customerNumber: "+919876543211", staffNumber: "+919876543212" });
    const sessionId = service.manager.allRecords()[0].sessionId;
    while (!resolveCreate) await new Promise(resolve => setImmediate(resolve));
    await service.close(sessionId, "cancelled");
    resolveCreate({ requestUuid: "late-provider-request", message: "offline" });
    await expect(creating).rejects.toThrow("INDEPENDENT_PROVIDER_CREATE_FAILED");
    expect(creates).toBe(1);
    expect(provider.stopped).toEqual([{ requestUuid: "late-provider-request", callUuid: null }]);
    expect(service.describe(sessionId).cleanupPending).toBe(false);
    await service.dispose();
  });
  it("rejects a live provider before any provider method is entered", async () => {
    let invoked = false;
    const provider = { mode: "live" as const, async createLeg() { invoked = true; throw new Error("must not run"); }, async stopLeg() { invoked = true; } };
    const service = new IndependentCallOrchestrator({ provider, publicBaseUrl: "https://offline.example", fromNumber: "+919876543210" });
    await expect(service.create({ customerNumber: "+919876543211", staffNumber: "+919876543212" })).rejects.toThrow("LIVE_CALL_APPROVAL_REQUIRED");
    expect(invoked).toBe(false); expect(service.sessionCount).toBe(0);
    await service.dispose();
  });
});
