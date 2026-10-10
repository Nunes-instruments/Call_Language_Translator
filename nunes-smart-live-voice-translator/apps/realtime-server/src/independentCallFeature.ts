import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { OfflineIndependentCallProvider, PlivoIndependentCallProvider, type IndependentCallProvider } from "./independentCallProvider.js";
import { IndependentCallOrchestrator } from "./independentCallOrchestrator.js";
import type { IndependentLiveCallManager } from "./independentLiveCallManager.js";
import { registerIndependentCallRoutes } from "./independentCallRoutes.js";
import { externalCallbackUrl, callbackParams } from "./plivoCallbackRequest.js";
import { guardPlivoWebhookRequest } from "./plivoWebhookRequestGuard.js";
import type { CallLegRole } from "./independentCallSessionEngine.js";
import { ScriptedSarvamMock, type SarvamProviders } from "./sarvamPipelineAdapters.js";
import type { ManagementStore } from "../../../packages/database/src/managementStore.js";

interface FeatureOptions {
  store?: ManagementStore;
  offlineTranslationProviders?: SarvamProviders;
  customGlossary?: string[];
  allowDirectBypass?: boolean;
  env: Record<string, string | undefined>;
  manager?: IndependentLiveCallManager;
  provider?: IndependentCallProvider;
  now?: () => number;
}

export async function registerIndependentCallFeature(app: FastifyInstance, options: FeatureOptions): Promise<IndependentCallOrchestrator | undefined> {
  const env = options.env;
  if (env.NUNES_INDEPENDENT_CALLS_ENABLED !== "true") return undefined;
  if (!env.PUBLIC_BASE_URL || !env.PLIVO_AUTH_TOKEN || !env.PLIVO_NUMBER) throw new Error("INDEPENDENT_CALL_CONFIGURATION_MISSING");
  const service = new IndependentCallOrchestrator({
    store: options.store,
    manager: options.manager, publicBaseUrl: env.PUBLIC_BASE_URL,
    fromNumber: env.PLIVO_NUMBER,
    customGlossary: options.customGlossary,
    allowDirectBypass: options.allowDirectBypass,
    provider: options.provider ?? (
      env.NUNES_INDEPENDENT_CALLS_TEST_MODE !== "true" && env.PLIVO_AUTH_ID && env.PLIVO_AUTH_TOKEN
        ? new PlivoIndependentCallProvider({ authId: env.PLIVO_AUTH_ID, authToken: env.PLIVO_AUTH_TOKEN })
        : new OfflineIndependentCallProvider()
    ),
    now: options.now,
    offlineTranslationProviders: options.offlineTranslationProviders ?? (env.NUNES_OFFLINE_TRANSLATION_ENABLED === "true" && env.NUNES_INDEPENDENT_CALLS_TEST_MODE === "true" ? new ScriptedSarvamMock() : undefined),
  });
  const authorizeAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const configured = env.NUNES_ADMIN_PASSWORD;
    const authorization = request.headers.authorization;
    if (!configured) return reply.code(503).send({ error: "Admin authentication unavailable" });
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return reply.code(401).send({ error: "Unauthorized" });
    const expected = Buffer.from(configured);
    const actual = Buffer.from(authorization.slice(7));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply.code(401).send({ error: "Unauthorized" });
  };

  app.post<{ Body: { customerNumber: string; staffNumber: string } }>("/internal/independent-calls", { preValidation: authorizeAdmin, bodyLimit: 4096 }, async (request, reply) => {
    if (env.NUNES_INDEPENDENT_CALLS_TEST_MODE !== "true" || service.options.provider.mode !== "offline") {
      return reply.code(403).send({ error: "LIVE_CALL_APPROVAL_REQUIRED" });
    }
    try { return reply.code(201).send(await service.create(request.body)); }
    catch (error) {
      const code = error instanceof Error ? error.message : "INDEPENDENT_CALL_FAILED";
      const status = code === "INDEPENDENT_PROVIDER_CREATE_FAILED" ? 502 : code === "SESSION_CAPACITY_EXCEEDED" ? 503 : 400;
      return reply.code(status).send({ error: code });
    }
  });
  app.get<{ Params: { sessionId: string } }>("/internal/independent-calls/:sessionId", { preValidation: authorizeAdmin }, async (request, reply) => {
    try { return service.describe(request.params.sessionId); }
    catch { return reply.code(404).send({ error: "Session not found" }); }
  });
  app.delete<{ Params: { sessionId: string } }>("/internal/independent-calls/:sessionId", { preValidation: authorizeAdmin }, async (request, reply) => {
    try {
      service.describe(request.params.sessionId);
      await service.close(request.params.sessionId, "admin-cancelled");
      return service.describe(request.params.sessionId);
    } catch { return reply.code(404).send({ error: "Session not found" }); }
  });
  await registerIndependentCallRoutes(app, { manager: service.manager, publicBaseUrl: env.PUBLIC_BASE_URL, authToken: env.PLIVO_AUTH_TOKEN, orchestrator: service, store: options.store });

  const upgradeIdentity = new WeakMap<FastifyRequest, { sessionId: string; role: CallLegRole; token: string }>();
  app.get("/plivo/independent/stream", {
    websocket: true,
    preValidation: async (request, reply) => {
      try {
        if (request.headers.upgrade?.toLowerCase() !== "websocket") throw new Error("UPGRADE_REQUIRED");
        const query = callbackParams(request.query);
        if (Object.keys(query).sort().join(",") !== "connectionToken,role,sessionId") throw new Error("INVALID_STREAM_QUERY");
        const { sessionId, role, connectionToken } = query;
        if (!sessionId || (role !== "customer" && role !== "staff") || !connectionToken) throw new Error("INVALID_STREAM_IDENTITY");
        const webhook = {
          method: "GET", callbackUrl: externalCallbackUrl(env.PUBLIC_BASE_URL!, request.url, "/plivo/independent/stream"),
          headers: request.headers, params: {}, authToken: env.PLIVO_AUTH_TOKEN,
        };
        if (!guardPlivoWebhookRequest(webhook).allowed) throw new Error("PLIVO_WEBHOOK_UNAUTHORIZED");
        service.authorizeUpgrade(sessionId, role, connectionToken);
        service.replay.claim(webhook, sessionId, true); // Every upgraded connection needs a fresh provider nonce.
        upgradeIdentity.set(request, { sessionId, role, token: connectionToken });
      } catch { return reply.code(403).send("Forbidden"); }
    },
  }, (socket, request) => {
    const identity = upgradeIdentity.get(request);
    if (!identity) { socket.close(1008, "Unauthorized"); return; }
    const { sessionId, role, token } = identity;
    upgradeIdentity.delete(request);
    try { service.openSocket(sessionId, role, token, socket); }
    catch { socket.close(1008, "Ownership rejected"); return; }
    const persist = (event: string) => { void service.persist(sessionId,event).catch(() => service.close(sessionId,"persistence-failure")); };
    const disconnect = () => { const removed = service.disconnectSocket(sessionId, role, socket); if (removed) persist("socket.disconnected"); return removed; };
    socket.on("close", disconnect);
    socket.on("error", () => { disconnect(); socket.close(1008, "Stream error"); });
    socket.on("message", (raw, isBinary) => {
      try {
        if (isBinary || Buffer.byteLength(raw.toString()) > 65_536) throw new Error("INVALID_STREAM_MESSAGE");
        const message = JSON.parse(raw.toString()) as { event?: unknown; start?: unknown; streamId?: unknown };
        if (!message || typeof message !== "object") throw new Error("INVALID_STREAM_MESSAGE");
        if (message.event === "start") { service.startSocket(sessionId, role, socket, message.start); persist("socket.started"); }
        else if (message.event === "media") service.media(sessionId, role, socket, message);
        else if (message.event === "stop") {
          // A socket event does not mutate the signed HTTP stream registry.
          disconnect(); socket.close(1000, "Stream ended");
        } else throw new Error("UNSUPPORTED_STREAM_MESSAGE");
      } catch { disconnect(); socket.close(1008, "Invalid stream message"); }
    });
  });

  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void service.sweep().catch(() => { app.log.error("Independent cleanup sweep failed"); }).finally(() => { sweeping = false; });
  }, 1000);
  timer.unref();
  app.addHook("preClose", async () => { clearInterval(timer); await service.dispose(); });
  return service;
}
