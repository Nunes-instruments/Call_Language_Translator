import { externalCallbackUrl, callbackParams, signedRequestParams } from "./plivoCallbackRequest.js";
import type { FastifyInstance } from "fastify";
import type { IndependentLiveCallManager } from "./independentLiveCallManager.js";
import { SignedIndependentCallCallbacks } from "./signedIndependentCallCallbacks.js";
import type { CallLegRole } from "./independentCallSessionEngine.js";
import type { PlivoWebhookRequestInput } from "./plivoWebhookRequestGuard.js";
import { guardPlivoWebhookRequest } from "./plivoWebhookRequestGuard.js";
import { IndependentCallbackReplay } from "./independentCallbackReplay.js";
import type { IndependentCallOrchestrator } from "./independentCallOrchestrator.js";
import { createHash } from "node:crypto";
import type { ManagementStore } from "../../../packages/database/src/managementStore.js";

interface IndependentRouteOptions {
  store?: ManagementStore;
  manager: IndependentLiveCallManager;
  publicBaseUrl: string;
  authToken: string;
  orchestrator?: IndependentCallOrchestrator;
  replay?: IndependentCallbackReplay;
}
function required(params: Record<string, string>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new Error("MISSING_OR_INVALID_" + key);
  return value;
}

export async function registerIndependentCallRoutes(app: FastifyInstance, options: IndependentRouteOptions): Promise<void> {
  const callbacks = new SignedIndependentCallCallbacks(options.manager);
  const replay = options.replay ?? options.orchestrator?.replay ?? new IndependentCallbackReplay();
  const routes = [
    { path: "/plivo/independent/answered", action: "answered" },
    { path: "/plivo/independent/stream-status", action: "stream-status" },
    { path: "/plivo/independent/stream-started", action: "stream-started" },
    { path: "/plivo/independent/stream-stopped", action: "stream-stopped" },
    { path: "/plivo/independent/completed", action: "completed" },
  ] as const;
  for (const route of routes) {
    app.route({ method: ["GET", "POST"], url: route.path, bodyLimit: 16_384,
      handler: async (request, reply) => {
        try {
          const query = callbackParams(request.query);
          const params = signedRequestParams(request);
          if (request.method === "POST" && Object.keys(params).some(key => key in query)) throw new Error("DUPLICATE_CALLBACK_PARAMETER");
          const webhook: PlivoWebhookRequestInput = {
            method: request.method,
            callbackUrl: externalCallbackUrl(options.publicBaseUrl, request.url, route.path),
            headers: request.headers, params: request.method === "GET" ? {} : params, authToken: options.authToken,
          };
          if (!guardPlivoWebhookRequest(webhook).allowed) throw new Error("PLIVO_WEBHOOK_UNAUTHORIZED");
          const sessionId = required(query, "sessionId");
          const role = required(query, "role");
          if (role !== "customer" && role !== "staff") throw new Error("INVALID_ROLE");
          if (!options.manager.getSession(sessionId)) throw new Error("SESSION_NOT_FOUND");
          const claim = replay.claim(webhook, sessionId);
          if (claim.cached) return reply.code(claim.cached.status).type(claim.cached.contentType).send(claim.cached.body);
          const receipt = await options.store?.callbackClaim(sessionId,claim.nonce,createHash("sha256").update(JSON.stringify([webhook.method,webhook.callbackUrl,Object.entries(params).sort()])).digest("hex"));
          const input = { webhook, sessionId, role: role as CallLegRole, callUuid: required(params, "CallUUID") };
          let body = "OK";
          let contentType = "text/plain";
          if (route.action === "answered") {
            callbacks.answered(input);
            if (options.orchestrator) {
              body = options.orchestrator.answerXml(sessionId, input.role);
              contentType = "application/xml";
            }
          } else if (route.action === "completed") {
            callbacks.completed(input);
            await options.orchestrator?.close(sessionId, params.CallStatus === "failed" ? "provider-failure" : `${role}-hangup`);
          } else {
            const streamId = required(params, "StreamID");
            const event = route.action === "stream-status" ? required(params, "Event") : route.action === "stream-started" ? "started" : "stopped";
            // Both forms occur in current Plivo documentation; unknown event names fail closed.
            if (event === "started" || event === "StartStream") {
              options.orchestrator?.assertStreamAllowed(sessionId, input.role, streamId);
              callbacks.streamStarted({ ...input, streamId });
              options.orchestrator?.streamStarted(sessionId, input.role, streamId);
            } else if (["stopped", "StopStream", "failed", "DroppedStream"].includes(event)) {
              const detached = callbacks.streamStopped({ ...input, streamId });
              if (detached) options.orchestrator?.streamStopped(sessionId, input.role, streamId);
              if (event === "failed" || event === "DroppedStream") {
                const currentStream = options.manager.getSession(sessionId)?.[input.role].streamId;
                if (!detached && (currentStream || options.orchestrator?.isRetiredStream(sessionId, streamId))) throw new Error("FAILED_STREAM_NOT_OWNED");
                await options.orchestrator?.close(sessionId, "stream-failure");
              }
            } else throw new Error("UNSUPPORTED_STREAM_EVENT");
          }
          await options.orchestrator?.persist(sessionId,`callback.${route.action}`,receipt);
          if (receipt) await options.store?.callbackComplete(receipt);
          replay.complete(claim.nonce, { status: 200, body, contentType });
          return reply.code(200).type(contentType).send(body);
        } catch {
          return reply.code(403).send("Forbidden");
        }
      },
    });
  }
}
