import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ManagementStore, StoreError, type Actor } from "../../../packages/database/src/managementStore.js";
export const productionGates = Object.freeze({ actualAudioIsolationVerified: false, productionTranslationAuthorized: false, livePlayback: "BLOCKED", originalBypass: "BLOCKED" });
const equal = (value: string, configured?: string) => Boolean(configured && Buffer.byteLength(value) === Buffer.byteLength(configured) && timingSafeEqual(Buffer.from(value),Buffer.from(configured)));
export async function registerManagementRoutes(app: FastifyInstance, options: { store: ManagementStore; env: Record<string,string | undefined>; now?: () => number }) {
  const actors = new WeakMap<FastifyRequest,Actor>(), windows = new Map<string,{ since: number; count: number }>();
  const now = options.now ?? Date.now;
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control","no-store");
    const ip = request.raw.socket.remoteAddress ?? "unknown", timestamp = now();
    for (const [key,window] of windows) if (timestamp-window.since >= 60000) windows.delete(key);
    if (!windows.has(ip) && windows.size >= 4096) return reply.code(429).send({ error: "RATE_LIMITED" });
    const window = windows.get(ip) ?? { since: timestamp,count:0 }; window.count++; windows.set(ip,window);
    if (window.count > 120) return reply.code(429).send({ error: "RATE_LIMITED" });
    if (!options.env.NUNES_ADMIN_PASSWORD) return reply.code(503).send({ error: "AUTH_UNAVAILABLE" });
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return reply.code(401).send({ error: "UNAUTHORIZED" });
    const value = authorization.slice(7);
    const role = equal(value,options.env.NUNES_ADMIN_PASSWORD) ? "ADMIN" : equal(value,options.env.NUNES_VIEWER_PASSWORD) ? "VIEWER" : undefined;
    if (!role) return reply.code(401).send({ error: "UNAUTHORIZED" });
    if (request.method !== "GET" && role !== "ADMIN") return reply.code(403).send({ error: "ADMIN_REQUIRED" });
    actors.set(request,{ role,name: role === "ADMIN" ? "shared-admin" : "shared-viewer" });
  };
  await app.register(async scoped => {
    scoped.addHook("preValidation",authorize);
    scoped.setErrorHandler((error, _request, reply) => {
      const status = error instanceof StoreError ? error.status : (error as { code?: string }).code === "23505" ? 409 : (error as { statusCode?: number }).statusCode === 400 ? 400 : 503;
      reply.code(status).send({ error: error instanceof StoreError ? error.message : status === 409 ? "DUPLICATE_VALUE" : status === 400 ? "INVALID_REQUEST" : "DATABASE_UNAVAILABLE" });
    });
    scoped.get("/management/identity",async request => actors.get(request));
    scoped.get("/management/overview",async () => options.store.overview());
    scoped.get("/management/employees",async () => ({ items: await options.store.employees() }));
    scoped.post("/management/employees",{ bodyLimit:8192 },async request => options.store.saveEmployee(request.body,actors.get(request)!));
    scoped.put<{ Params:{id:string} }>("/management/employees/:id",{ bodyLimit:8192 },async request => options.store.saveEmployee(request.body,actors.get(request)!,request.params.id));
    scoped.delete<{ Params:{id:string} }>("/management/employees/:id",async request => { await options.store.deleteEmployee(request.params.id,actors.get(request)!); return { deleted:true }; });
    scoped.get<{ Querystring:{search?:string} }>("/management/glossary",async request => ({ items: await options.store.glossary(request.query.search) }));
    scoped.post("/management/glossary",{ bodyLimit:8192 },async request => options.store.saveGlossary(request.body,actors.get(request)!));
    scoped.put<{ Params:{id:string} }>("/management/glossary/:id",{ bodyLimit:8192 },async request => options.store.saveGlossary(request.body,actors.get(request)!,request.params.id));
    scoped.delete<{ Params:{id:string} }>("/management/glossary/:id",async request => { await options.store.deleteGlossary(request.params.id,actors.get(request)!); return { deleted:true }; });
    scoped.post("/management/glossary/import",{ bodyLimit:32768 },async request => options.store.importGlossary(request.body,actors.get(request)!));
    scoped.get<{ Querystring:{page?:string;limit?:string;search?:string;status?:string;mode?:string;live?:string} }>("/management/calls",async request => options.store.history({ ...request.query,page: request.query.page ? Number(request.query.page) : 1,limit:request.query.limit ? Number(request.query.limit):20,live:request.query.live === "true" }));
    scoped.get<{ Params:{id:string} }>("/management/calls/:id",async request => options.store.detail(request.params.id));
    scoped.get("/management/settings",async () => ({ settings: await options.store.settings(),gates:productionGates,translationConfigurationScope:"persisted-policy; production activation remains blocked" }));
    scoped.put<{ Params:{kind:string} }>("/management/settings/:kind",{ bodyLimit:4096 },async request => options.store.saveSettings(request.params.kind,request.body,actors.get(request)!));
    scoped.post("/management/retention/cleanup",async request => options.store.cleanup(actors.get(request)!));
    scoped.get<{ Querystring:{page?:string} }>("/management/audit",async request => ({ items: await options.store.auditHistory(request.query.page ? Number(request.query.page):1) }));
    const diagnostics = async () => {
      let database = "UNAVAILABLE"; try { await options.store.health(); database = "CONNECTED"; } catch { /* never expose driver errors */ }
      return { server:"AVAILABLE",database,persistence:database === "CONNECTED" ? "READY" : "BLOCKED",providers: { plivo:{ configured:Boolean(options.env.PLIVO_AUTH_ID && options.env.PLIVO_AUTH_TOKEN && options.env.PLIVO_NUMBER),connection:"NOT_VERIFIED" },sarvam:{ configured:Boolean(options.env.SARVAM_API_KEY),connection:"NOT_VERIFIED" },neon:{ configured:Boolean(options.env.DATABASE_URL),connection:database } },callbackAuthentication:"SDK_V3_REQUIRED",streamOwnership:"SIGNED_CALL_AND_STREAM_REQUIRED",translationPipeline:"OFFLINE_ONLY",...productionGates,productionReady:false };
    };
    scoped.get("/management/diagnostics",diagnostics); scoped.get("/management/providers",diagnostics);
  });
}
