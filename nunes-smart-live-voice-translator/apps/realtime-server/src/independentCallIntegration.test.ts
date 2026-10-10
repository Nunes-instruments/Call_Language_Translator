import { randomUUID } from "node:crypto";
import { once } from "node:events";
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { registerIndependentCallFeature } from "./independentCallFeature.js";
import { OfflineIndependentCallProvider, PlivoIndependentCallProvider } from "./independentCallProvider.js";
import { IndependentLiveCallManager } from "./independentLiveCallManager.js";
import { createIndependentPlivoCall } from "./independentPlivoCallCreator.js";
import { offlineHeaders } from "./testSupport/plivoOfflineSignature.js";
import { ScriptedSarvamMock } from "./sarvamPipelineAdapters.js";
import { encodeMulaw } from "./telephonyAudioCodec.js";

const env = {
  NUNES_INDEPENDENT_CALLS_ENABLED: "true", NUNES_INDEPENDENT_CALLS_TEST_MODE: "true",
  PUBLIC_BASE_URL: "https://offline.example", PLIVO_AUTH_TOKEN: "offline-webhook-token", PLIVO_NUMBER: "+919876543210", NUNES_ADMIN_PASSWORD: "offline-admin",
};
const admin = { authorization: "Bearer offline-admin" };
const numbers = { customerNumber: "+919876543211", staffNumber: "+919876543212" };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function eventually(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  expect(check()).toBe(true);
}
async function setup(overrides: Partial<typeof env> & { NUNES_OFFLINE_TRANSLATION_ENABLED?: string } = {}, provider = new OfflineIndependentCallProvider(), now?: () => number, manager?: IndependentLiveCallManager, offlineTranslationProviders?: ScriptedSarvamMock) {
  const app = Fastify();
  await app.register(formbody);
  await app.register(websocket, { options: { maxPayload: 65_536 } });
  // Regression sentinel: independent registration leaves the legacy route available.
  app.all("/plivo/inbound", async () => '<Response><Dial><Number>legacy</Number></Dial></Response>');
  const service = await registerIndependentCallFeature(app, { env: { ...env, ...overrides }, provider, now, manager, offlineTranslationProviders });
  await app.ready();
  const clients: WebSocket[] = [];
  return { app, service: service!, provider, clients,
    async cleanup() { for (const client of clients) client.terminate(); await app.close(); },
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function create(fixture: Fixture) {
  const response = await fixture.app.inject({ method: "POST", url: "/internal/independent-calls", headers: admin, payload: numbers });
  expect(response.statusCode).toBe(201);
  return response.json<{ sessionId: string }>().sessionId;
}
function leg(fixture: Fixture, sessionId: string, role: "customer" | "staff") {
  return fixture.provider.created.find(item => item.sessionId === sessionId && item.role === role)!;
}
async function callback(fixture: Fixture, target: string, params: Record<string, string>, nonce?: string) {
  const url = new URL(target);
  return fixture.app.inject({ method: "POST", url: url.pathname + url.search,
    headers: { ...offlineHeaders("POST", target, params, env.PLIVO_AUTH_TOKEN, nonce), "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(params).toString(),
  });
}
async function answer(fixture: Fixture, sessionId: string, role: "customer" | "staff", callUuid: string = randomUUID()) {
  const created = leg(fixture, sessionId, role);
  const params = { CallUUID: callUuid, RequestUUID: created.requestUuid, Event: "StartApp", Direction: "outbound", CallStatus: "in-progress" };
  const response = await callback(fixture, created.answerUrl, params);
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain("application/xml");
  expect(response.body).not.toMatch(/<Dial|<Conference|<Speak|<Play/);
  const streamUrl = new URL(response.body.match(/>(wss:\/\/[^<]+)<\/Stream>/)![1].replaceAll("&amp;", "&"));
  const statusUrl = response.body.match(/statusCallbackUrl="([^"]+)"/)![1].replaceAll("&amp;", "&");
  return { callUuid, params, streamUrl, statusUrl, streamId: randomUUID() };
}
type Answer = Awaited<ReturnType<typeof answer>>;
async function started(fixture: Fixture, answered: Answer, event = "started", nonce?: string) {
  return callback(fixture, answered.statusUrl, { CallUUID: answered.callUuid, StreamID: answered.streamId, Event: event }, nonce);
}
async function connect(fixture: Fixture, answered: Answer, nonce?: string) {
  const url = new URL(answered.streamUrl);
  url.protocol = "https:";
  const client = await fixture.app.injectWS(url.pathname + url.search, { headers: offlineHeaders("GET", url.toString(), {}, env.PLIVO_AUTH_TOKEN, nonce) });
  fixture.clients.push(client);
  return client;
}
function startMessage(answered: Answer) {
  return { event: "start", sequenceNumber: 1, start: { callId: answered.callUuid, streamId: answered.streamId, tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000 } } };
}
function mediaMessage(answered: Answer, sequenceNumber = 2) {
  return { event: "media", sequenceNumber, streamId: answered.streamId, media: { track: "inbound", payload: Buffer.alloc(160, 0xff).toString("base64") } };
}

describe("Independent two-leg Fastify integration (offline provider only)", () => {
  it("processes signed owned media into mock opposite-leg queues without sending playback", async () => {
    const mock = new ScriptedSarvamMock(); mock.transcripts.push({ text: "mujhe Fluke 754 chahiye", language: "hi-IN", confidence: .99, final: true });
    const fixture = await setup({ NUNES_OFFLINE_TRANSLATION_ENABLED: "true" }, undefined, undefined, undefined, mock);
    try {
      const sessionId = await create(fixture), customer = await answer(fixture, sessionId, "customer"), staff = await answer(fixture, sessionId, "staff");
      await started(fixture, customer); await started(fixture, staff);
      const customerSocket = await connect(fixture, customer), staffSocket = await connect(fixture, staff), received = vi.fn();
      customerSocket.on("message", received); staffSocket.on("message", received);
      customerSocket.send(JSON.stringify(startMessage(customer))); staffSocket.send(JSON.stringify(startMessage(staff)));
      await eventually(() => fixture.service.describe(sessionId).customer.socketConnected && fixture.service.describe(sessionId).staff.socketConnected);
      const speech = encodeMulaw(Int16Array.from({ length: 1600 }, (_, index) => Math.round(5000 * Math.sin(index * .2))));
      customerSocket.send(JSON.stringify({ ...mediaMessage(customer, 2), media: { track: "inbound", payload: speech.toString("base64") } }));
      customerSocket.send(JSON.stringify({ ...mediaMessage(customer, 3), media: { track: "inbound", payload: Buffer.alloc(2400, 255).toString("base64") } }));
      await eventually(() => fixture.service.describe(sessionId).offlineTranslation?.metrics.prepared === 1);
      expect(fixture.service.describe(sessionId).offlineTranslation?.queued.customerToStaff).toBe(1);
      expect(received).not.toHaveBeenCalled(); expect(mock.calls).toEqual({ stt: 1, translation: 1, tts: 1 });
      await fixture.service.close(sessionId, "offline-test");
      expect(fixture.service.describe(sessionId).offlineTranslation?.queued.customerToStaff).toBe(0);
    } finally { await fixture.cleanup(); }
  });
  it("creates distinct requests, answers both legs, connects streams and receives isolated media without sending audio", async () => {
    const fixture = await setup();
    try {
      const sessionId = await create(fixture);
      expect(fixture.provider.created).toHaveLength(2);
      expect(leg(fixture, sessionId, "customer").requestUuid).not.toBe(leg(fixture, sessionId, "staff").requestUuid);
      const customer = await answer(fixture, sessionId, "customer");
      const staff = await answer(fixture, sessionId, "staff");
      expect(customer.callUuid).not.toBe(leg(fixture, sessionId, "customer").requestUuid);
      expect((await started(fixture, customer)).statusCode).toBe(200);
      expect((await started(fixture, staff)).statusCode).toBe(200);
      const customerSocket = await connect(fixture, customer);
      const staffSocket = await connect(fixture, staff);
      const received = vi.fn();
      customerSocket.on("message", received); staffSocket.on("message", received);
      customerSocket.send(JSON.stringify(startMessage(customer)));
      staffSocket.send(JSON.stringify(startMessage(staff)));
      await eventually(() => fixture.service.describe(sessionId).customer.socketConnected && fixture.service.describe(sessionId).staff.socketConnected);
      customerSocket.send(JSON.stringify(mediaMessage(customer)));
      staffSocket.send(JSON.stringify(mediaMessage(staff)));
      await eventually(() => fixture.service.describe(sessionId).customer.frames === 1 && fixture.service.describe(sessionId).staff.frames === 1);
      const state = fixture.service.describe(sessionId);
      expect(state.state).toBe("connected");
      expect(state.customer.bytes).toBe(160); expect(state.staff.bytes).toBe(160);
      expect(state.audioIsolationVerified).toBe(false); expect(state.translationEnabled).toBe(false);
      expect(received).not.toHaveBeenCalled();
      expect(() => fixture.service.forwardAudio()).toThrow("AUDIO_ISOLATION_UNVERIFIED");
      expect(() => fixture.service.enableTranslation()).toThrow("AUDIO_ISOLATION_UNVERIFIED");
      expect((await fixture.app.inject({ url: "/plivo/inbound" })).body).toContain("<Dial>");
    } finally { await fixture.cleanup(); }
  });

  for (const role of ["customer", "staff"] as const) {
    it(`cleans up both legs when ${role} hangs up, including duplicate delivery`, async () => {
      const fixture = await setup();
      try {
        const sessionId = await create(fixture);
        const customer = await answer(fixture, sessionId, "customer");
        const staff = await answer(fixture, sessionId, "staff");
        await started(fixture, customer); await started(fixture, staff);
        const client = await connect(fixture, customer);
        client.send(JSON.stringify(startMessage(customer)));
        await tick();
        const selected = role === "customer" ? customer : staff;
        const params = { CallUUID: selected.callUuid, RequestUUID: leg(fixture, sessionId, role).requestUuid, Event: "Hangup", CallStatus: "completed" };
        const target = leg(fixture, sessionId, role).hangupUrl;
        expect((await callback(fixture, target, params, "hangup-nonce")).statusCode).toBe(200);
        expect((await callback(fixture, target, params, "hangup-nonce")).statusCode).toBe(200);
        expect((await callback(fixture, target, params)).statusCode).toBe(200);
        expect(fixture.provider.stopped).toHaveLength(2);
        expect(fixture.service.describe(sessionId).state).toBe("closed");
        expect(fixture.service.socketCount).toBe(0);
      } finally { await fixture.cleanup(); }
    });
  }
  it("cleans up the successful customer request when staff creation fails", async () => {
    const provider = new OfflineIndependentCallProvider(); provider.failRole = "staff";
    const fixture = await setup({}, provider);
    try {
      const response = await fixture.app.inject({ method: "POST", url: "/internal/independent-calls", headers: admin, payload: numbers });
      expect(response.statusCode).toBe(502);
      expect(provider.created).toHaveLength(1); expect(provider.stopped).toHaveLength(1);
      expect(fixture.service.manager.allRecords()[0].state).toBe("closed");
    } finally { await fixture.cleanup(); }
  });
  it("handles unanswered failure/hangup using request UUID ownership", async () => {
    const fixture = await setup();
    try {
      const sessionId = await create(fixture);
      const created = leg(fixture, sessionId, "staff");
      const response = await callback(fixture, created.hangupUrl, { RequestUUID: created.requestUuid, CallUUID: randomUUID(), CallStatus: "failed", Event: "Hangup" });
      expect(response.statusCode).toBe(200);
      expect(fixture.service.describe(sessionId).state).toBe("closed");
      expect(fixture.provider.stopped).toHaveLength(2);
    } finally { await fixture.cleanup(); }
  });
  it("makes answer retries idempotent and refuses request UUID mismatch or request-as-call confusion", async () => {
    const fixture = await setup();
    try {
      const sessionId = await create(fixture);
      const created = leg(fixture, sessionId, "customer");
      expect((await callback(fixture, created.answerUrl, { CallUUID: "unbound-call", RequestUUID: "forged-request" })).statusCode).toBe(403);
      expect(fixture.service.manager.getSession(sessionId)?.customer.callUuid).toBeNull();
      const customer = await answer(fixture, sessionId, "customer");
      const first = await callback(fixture, created.answerUrl, customer.params, "answer-retry");
      const duplicate = await callback(fixture, created.answerUrl, customer.params, "answer-retry");
      expect(first.statusCode).toBe(200); expect(duplicate.body).toBe(first.body);
      expect((await callback(fixture, created.answerUrl, { ...customer.params, CallUUID: created.requestUuid })).statusCode).toBe(403);
      expect((await callback(fixture, created.answerUrl, { ...customer.params, ALegRequestUUID: "different" })).statusCode).toBe(403);
    } finally { await fixture.cleanup(); }
  });
  it("rejects forged signatures and signed cross-session/cross-leg request claims", async () => {
    const fixture = await setup();
    try {
      const first = await create(fixture); const second = await create(fixture);
      const source = leg(fixture, first, "customer");
      const params = { CallUUID: "spoofed-call", RequestUUID: source.requestUuid };
      const target = new URL(source.answerUrl);
      const unsigned = await fixture.app.inject({ method: "POST", url: target.pathname + target.search, payload: params });
      expect(unsigned.statusCode).toBe(403);
      expect((await callback(fixture, leg(fixture, second, "customer").answerUrl, params)).statusCode).toBe(403);
      expect((await callback(fixture, leg(fixture, first, "staff").answerUrl, params)).statusCode).toBe(403);
      expect(fixture.service.manager.getSession(second)?.customer.callUuid).toBeNull();
    } finally { await fixture.cleanup(); }
  });
  it("rejects altered/reordered replay identities but permits exact callback retry without mutation", async () => {
    const fixture = await setup();
    try {
      const sessionId = await create(fixture);
      const created = leg(fixture, sessionId, "customer");
      const params = { CallUUID: "owned-call", RequestUUID: created.requestUuid };
      expect((await callback(fixture, created.answerUrl, params, "same-nonce")).statusCode).toBe(200);
      expect((await callback(fixture, created.answerUrl, { ...params, CallUUID: "other" }, "same-nonce")).statusCode).toBe(403);
      const url = new URL(created.answerUrl);
      url.search = `role=customer&sessionId=${sessionId}`;
      // Query order is canonicalized in both signature verification and replay identity.
      expect((await callback(fixture, url.toString(), params, "same-nonce")).statusCode).toBe(200);
      expect(fixture.service.manager.getSession(sessionId)?.customer.callUuid).toBe("owned-call");
    } finally { await fixture.cleanup(); }
  });
  it("rejects stream status claiming another session's active stream", async () => {
    const fixture = await setup();
    try {
      const first = await create(fixture); const second = await create(fixture);
      const a = await answer(fixture, first, "customer"); const b = await answer(fixture, second, "customer");
      expect((await started(fixture, a)).statusCode).toBe(200);
      b.streamId = a.streamId;
      expect((await started(fixture, b)).statusCode).toBe(403);
      expect(fixture.service.manager.getSession(second)?.customer.streamId).toBeNull();
    } finally { await fixture.cleanup(); }
  });
  it("holds media until signed HTTP stream registration arrives", async () => {
    const fixture = await setup();
    try {
      const sessionId = await create(fixture); const customer = await answer(fixture, sessionId, "customer");
      const client = await connect(fixture, customer);
      client.send(JSON.stringify(startMessage(customer))); client.send(JSON.stringify(mediaMessage(customer)));
      await tick(); await tick();
      expect(fixture.service.describe(sessionId).customer.frames).toBe(0);
      expect((await started(fixture, customer)).statusCode).toBe(200);
      client.send(JSON.stringify(mediaMessage(customer, 3)));
      await eventually(() => fixture.service.describe(sessionId).customer.frames === 1);
    } finally { await fixture.cleanup(); }
  });
  it("rejects unsigned/invalid-token upgrades and duplicate socket owners", async () => {
    const fixture = await setup();
    try {
      const sessionId = await create(fixture); const customer = await answer(fixture, sessionId, "customer");
      const target = customer.streamUrl.pathname + customer.streamUrl.search;
      await expect(fixture.app.injectWS(target)).rejects.toThrow("403");
      const bad = new URL(customer.streamUrl); bad.searchParams.set("connectionToken", "forged"); bad.protocol = "https:";
      await expect(fixture.app.injectWS(bad.pathname + bad.search, { headers: offlineHeaders("GET", bad.toString(), {}, env.PLIVO_AUTH_TOKEN) })).rejects.toThrow("403");
      const owner = await connect(fixture, customer); owner.send(JSON.stringify(startMessage(customer)));
      await expect(connect(fixture, customer)).rejects.toThrow("403");
      expect(fixture.service.socketCount).toBe(1);
    } finally { await fixture.cleanup(); }
  });
  it("rejects mismatched start call/stream IDs before accepting media", async () => {
    const fixture = await setup();
    try {
      const sessionId = await create(fixture); const customer = await answer(fixture, sessionId, "customer");
      await started(fixture, customer);
      const client = await connect(fixture, customer);
      const close = once(client, "close");
      const message = startMessage(customer); message.start.callId = "wrong-call";
      client.send(JSON.stringify(message));
      expect((await close)[0]).toBe(1008);
      expect(fixture.service.describe(sessionId).customer.frames).toBe(0);
    } finally { await fixture.cleanup(); }
  });
  it("reconnects with fresh authentication and protects against upgrade replay and stale disconnects", async () => {
    const fixture = await setup();
    try {
      const sessionId = await create(fixture); const customer = await answer(fixture, sessionId, "customer");
      await started(fixture, customer);
      const first = await connect(fixture, customer, "first-upgrade"); first.send(JSON.stringify(startMessage(customer)));
      await eventually(() => fixture.service.describe(sessionId).customer.socketConnected);
      const closed = once(first, "close"); first.close(); await closed;
      await eventually(() => fixture.service.socketCount === 0);
      await expect(connect(fixture, customer, "first-upgrade")).rejects.toThrow("403");
      const replacement = await connect(fixture, customer); replacement.send(JSON.stringify(startMessage(customer)));
      await eventually(() => fixture.service.describe(sessionId).customer.socketConnected);
      expect(fixture.service.disconnectSocket(sessionId, "customer", first)).toBe(false);
      replacement.send(JSON.stringify(mediaMessage(customer)));
      await eventually(() => fixture.service.describe(sessionId).customer.frames === 1);
    } finally { await fixture.cleanup(); }
  });
  it("retires stopped streams, allows a new generation and ignores stale stop on the replacement", async () => {
    const fixture = await setup();
    try {
      const sessionId = await create(fixture); const customer = await answer(fixture, sessionId, "customer");
      await started(fixture, customer);
      expect((await started(fixture, customer, "stopped")).statusCode).toBe(200);
      expect((await started(fixture, customer)).statusCode).toBe(403);
      const replacement = { ...customer, streamId: randomUUID() };
      expect((await started(fixture, replacement)).statusCode).toBe(200);
      expect((await started(fixture, customer, "stopped")).statusCode).toBe(200);
      expect(fixture.service.manager.getSession(sessionId)?.customer.streamId).toBe(replacement.streamId);
    } finally { await fixture.cleanup(); }
  });
  it("cleans both legs on signed stream failure", async () => {
    const fixture = await setup();
    try {
      const sessionId = await create(fixture); const customer = await answer(fixture, sessionId, "customer");
      await started(fixture, customer);
      expect((await started(fixture, customer, "failed")).statusCode).toBe(200);
      expect(fixture.service.describe(sessionId).closeReason).toBe("stream-failure");
      expect(fixture.provider.stopped).toHaveLength(2);
    } finally { await fixture.cleanup(); }
  });
  it("never assigns the same socket object to customer and staff", async () => {
    const fixture = await setup();
    try {
      const sessionId = await create(fixture);
      const customer = await answer(fixture, sessionId, "customer");
      const staff = await answer(fixture, sessionId, "staff");
      const socket = { close: vi.fn(), readyState: 1 };
      fixture.service.openSocket(sessionId, "customer", customer.streamUrl.searchParams.get("connectionToken")!, socket);
      expect(() => fixture.service.openSocket(sessionId, "staff", staff.streamUrl.searchParams.get("connectionToken")!, socket)).toThrow("SOCKET_ALREADY_OWNED");
      expect(fixture.service.socketCount).toBe(1);
    } finally { await fixture.cleanup(); }
  });
  it("cleans up a stream that fails before its first started callback", async () => {
    const fixture = await setup();
    try {
      const sessionId = await create(fixture); const customer = await answer(fixture, sessionId, "customer");
      expect((await started(fixture, customer, "failed")).statusCode).toBe(200);
      expect(fixture.service.describe(sessionId).state).toBe("closed");
      expect(fixture.provider.stopped).toHaveLength(2);
    } finally { await fixture.cleanup(); }
  });
  it("rejects duplicate query/form parameters and unknown provider events", async () => {
    const fixture = await setup();
    try {
      const sessionId = await create(fixture); const customer = await answer(fixture, sessionId, "customer");
      expect((await started(fixture, customer, "unrecognized")).statusCode).toBe(403);
      const duplicate = new URL(leg(fixture, sessionId, "customer").answerUrl); duplicate.searchParams.append("role", "customer");
      expect((await callback(fixture, duplicate.toString(), customer.params)).statusCode).toBe(403);
      const url = new URL(leg(fixture, sessionId, "customer").answerUrl);
      expect((await fixture.app.inject({ method: "POST", url: url.pathname + url.search,
        headers: { ...offlineHeaders("POST", url.toString(), customer.params, env.PLIVO_AUTH_TOKEN), "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams(customer.params).toString() + "&CallUUID=spoofed",
      })).statusCode).toBe(403);
      expect(fixture.service.manager.getSession(sessionId)?.customer.streamId).toBeNull();
    } finally { await fixture.cleanup(); }
  });
  it("does not reset sequence protection on duplicate started callback", async () => {
    const fixture = await setup();
    try {
      const sessionId = await create(fixture); const customer = await answer(fixture, sessionId, "customer");
      await started(fixture, customer);
      const client = await connect(fixture, customer); client.send(JSON.stringify(startMessage(customer)));
      await eventually(() => fixture.service.describe(sessionId).customer.socketConnected);
      client.send(JSON.stringify(mediaMessage(customer, 10)));
      await eventually(() => fixture.service.describe(sessionId).customer.frames === 1);
      expect((await started(fixture, customer)).statusCode).toBe(200);
      const closed = once(client, "close");
      client.send(JSON.stringify(mediaMessage(customer, 10)));
      expect((await closed)[0]).toBe(1008);
      expect(fixture.service.describe(sessionId).customer.frames).toBe(1);
    } finally { await fixture.cleanup(); }
  });
  it("closes disconnected or orphaned sessions and releases closed sessions/replay state after retention", async () => {
    let now = 1000;
    const fixture = await setup({}, undefined, () => now);
    try {
      const sessionId = await create(fixture); const customer = await answer(fixture, sessionId, "customer");
      await started(fixture, customer);
      const client = await connect(fixture, customer); client.send(JSON.stringify(startMessage(customer)));
      await eventually(() => fixture.service.describe(sessionId).customer.socketConnected);
      const closed = once(client, "close"); client.close(); await closed;
      await eventually(() => fixture.service.socketCount === 0);
      now += 30_001; await fixture.service.sweep();
      expect(fixture.service.describe(sessionId).closeReason).toBe("reconnect-timeout");
      now += 60_001; await fixture.service.sweep();
      expect(fixture.service.sessionCount).toBe(0); expect(fixture.service.replay.size).toBe(0);
      expect(fixture.service.manager.getSession(sessionId)).toBeUndefined();
      expect((await started(fixture, customer)).statusCode).toBe(403);
      const orphan = await create(fixture);
      now += 30 * 60_000 + 1; await fixture.service.sweep();
      expect(fixture.service.describe(orphan).closeReason).toBe("session-timeout");
    } finally { await fixture.cleanup(); }
  });
  it("closes upgrades whose provider start/HTTP status never arrives", async () => {
    let now = 1000;
    const fixture = await setup({}, undefined, () => now);
    try {
      const sessionId = await create(fixture); const customer = await answer(fixture, sessionId, "customer");
      await connect(fixture, customer);
      now += 10_001; await fixture.service.sweep();
      expect(fixture.service.describe(sessionId).closeReason).toBe("stream-start-timeout");
    } finally { await fixture.cleanup(); }
  });
  it("retains failed-cleanup state and retries rather than claiming successful removal", async () => {
    let now = 1000;
    const provider = new OfflineIndependentCallProvider();
    const fixture = await setup({}, provider, () => now);
    try {
      const sessionId = await create(fixture); provider.failCleanup = true;
      await fixture.service.close(sessionId, "test-close");
      expect(fixture.service.describe(sessionId).cleanupPending).toBe(true);
      now += 60_001; await fixture.service.sweep();
      expect(fixture.service.sessionCount).toBe(1);
      provider.failCleanup = false; await fixture.service.sweep();
      expect(fixture.service.sessionCount).toBe(0);
    } finally { await fixture.cleanup(); }
  });
  it("exposes no independent endpoints when disabled", async () => {
    const fixture = await setup({ NUNES_INDEPENDENT_CALLS_ENABLED: "false" });
    try {
      expect(fixture.service).toBeUndefined();
      for (const url of ["/internal/independent-calls", "/plivo/independent/answered", "/plivo/independent/stream-status"]) {
        expect((await fixture.app.inject({ method: "POST", url, headers: admin, payload: numbers })).statusCode).toBe(404);
      }
      await expect(fixture.app.injectWS("/plivo/independent/stream")).rejects.toThrow("404");
      expect(fixture.provider.created).toHaveLength(0);
      expect((await fixture.app.inject({ url: "/plivo/inbound" })).statusCode).toBe(200);
    } finally { await fixture.cleanup(); }
  });
  it("requires admin authorization and explicit offline mode for creation", async () => {
    const fixture = await setup({ NUNES_INDEPENDENT_CALLS_TEST_MODE: "false" });
    try {
      for (const headers of [{}, { authorization: "Bearer wrong" }]) {
        expect((await fixture.app.inject({ method: "POST", url: "/internal/independent-calls", headers, payload: numbers })).statusCode).toBe(401);
      }
      expect((await fixture.app.inject({ method: "POST", url: "/internal/independent-calls", headers: admin, payload: numbers })).statusCode).toBe(403);
      expect(fixture.provider.created).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  });
  it("blocks direct live adapter and raw SDK call creation before a client can be constructed", async () => {
    const provider = new PlivoIndependentCallProvider({ authId: "unused", authToken: "unused" });
    await expect(provider.createLeg({ sessionId: "test", role: "customer", from: numbers.customerNumber, to: numbers.staffNumber, answerUrl: "https://offline.example/answer", hangupUrl: "https://offline.example/hangup" })).rejects.toThrow("LIVE_CALL_APPROVAL_REQUIRED");
    await expect(createIndependentPlivoCall({ authId: "unused", authToken: "unused", from: numbers.customerNumber, to: numbers.staffNumber, answerUrl: "https://offline.example/answer" })).rejects.toThrow("LIVE_CALL_APPROVAL_REQUIRED");
    await expect(provider.stopLeg({ requestUuid: "unused-request", callUuid: null })).rejects.toThrow("LIVE_CALL_APPROVAL_REQUIRED");
  });
  it("defaults to disabled without a flag and fails closed when admin authentication is missing", async () => {
    const disabled = await setup({ NUNES_INDEPENDENT_CALLS_ENABLED: undefined, PUBLIC_BASE_URL: "", PLIVO_AUTH_TOKEN: "" });
    try {
      expect(disabled.service).toBeUndefined();
      expect((await disabled.app.inject({ method: "POST", url: "/internal/independent-calls", headers: admin, payload: numbers })).statusCode).toBe(404);
    } finally { await disabled.cleanup(); }
    const unavailable = await setup({ NUNES_ADMIN_PASSWORD: "" });
    try {
      expect((await unavailable.app.inject({ method: "POST", url: "/internal/independent-calls", headers: admin, payload: numbers })).statusCode).toBe(503);
      expect(unavailable.provider.created).toHaveLength(0);
    } finally { await unavailable.cleanup(); }
  });
  it("rejects bounded-capacity overflow and leaves the existing session intact", async () => {
    const fixture = await setup({}, undefined, undefined, new IndependentLiveCallManager(1));
    try {
      const first = await create(fixture);
      expect((await fixture.app.inject({ method: "POST", url: "/internal/independent-calls", headers: admin, payload: numbers })).statusCode).toBe(503);
      expect(fixture.service.describe(first).state).toBe("pending");
      expect(fixture.provider.created).toHaveLength(2);
    } finally { await fixture.cleanup(); }
  });
});
