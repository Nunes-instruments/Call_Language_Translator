import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { IndependentCallOrchestrator } from "./independentCallOrchestrator.js";
import { ReceiveOnlyPilotAuthorizer, type ReservationResult } from "./receiveOnlyPilotAuthorization.js";

export const INDIAN_E164_REGEX = /^\+91[6-9]\d{9}$/;

export interface PilotAllowlist {
  customerNumber: string;
  staffNumber: string;
  confirmed?: boolean;
}

export function isValidIndianE164(phone: string): boolean {
  return INDIAN_E164_REGEX.test(phone.trim());
}

export interface ControlledPilotConfig {
  maxDurationSeconds?: number; // default 180s
  maxSessions?: number; // default 5
  maxBudgetUsd?: number; // default $2.00
  estimatedCostPerMinuteUsd?: number; // default $0.05
  allowlist?: PilotAllowlist;
  storagePath?: string;
}

export interface PilotSessionStartInput {
  customerNumber: string;
  staffNumber: string;
  operatorId: string;
  operatorConsent: boolean;
  authorizationToken?: string;
  idempotencyKey?: string;
}

export interface PilotSessionRecord {
  sessionId: string;
  customerNumberMasked: string;
  staffNumberMasked: string;
  operatorId: string;
  startedAt: number;
  endedAt?: number;
  durationSeconds?: number;
  estimatedCostUsd: number;
  status: "pending" | "in-progress" | "completed" | "terminated" | "failed";
  terminationReason?: string;
  error?: string;
  idempotencyKey?: string;
}

export function maskPhoneNumber(phone: string): string {
  const clean = phone.trim();
  if (clean.length <= 4) return "****";
  const visible = clean.slice(-4);
  const prefix = clean.startsWith("+") ? "+" : "";
  return `${prefix}${"*".repeat(Math.max(0, clean.length - visible.length - prefix.length))}${visible}`;
}

export const PILOT_SAFETY_GATES = Object.freeze({
  actualAudioIsolationVerified: false,
  productionTranslationAuthorized: false,
  livePlayback: "BLOCKED",
  originalBypass: "BLOCKED",
});

export class ControlledPilotManager {
  readonly gates = PILOT_SAFETY_GATES;

  private readonly maxDurationSeconds: number;
  private readonly maxSessions: number;
  private readonly maxBudgetUsd: number;
  private readonly estimatedCostPerMinuteUsd: number;
  private allowlist?: PilotAllowlist;

  private sessions = new Map<string, PilotSessionRecord>();
  private idempotencySessions = new Map<string, PilotSessionRecord>();
  private activeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private emergencyStopEngaged = false;
  private emergencyStopReason = "";
  private cumulativeEstimatedCostUsd = 0;
  readonly authorizer: ReceiveOnlyPilotAuthorizer;

  constructor(
    private readonly orchestrator?: IndependentCallOrchestrator,
    config: ControlledPilotConfig = {},
    private readonly now: () => number = Date.now
  ) {
    this.authorizer = new ReceiveOnlyPilotAuthorizer(300, this.now, config.storagePath);
    this.maxDurationSeconds = config.maxDurationSeconds ?? 180;
    this.maxSessions = config.maxSessions ?? 5;
    this.maxBudgetUsd = config.maxBudgetUsd ?? 2.0;
    this.estimatedCostPerMinuteUsd = config.estimatedCostPerMinuteUsd ?? 0.05;
    if (config.allowlist) {
      this.setAllowlist({ ...config.allowlist, confirmed: true });
    }
    if (this.orchestrator && typeof this.orchestrator.setTelemetryListener === "function") {
      this.orchestrator.setTelemetryListener({
        onStreamStart: (s, r, st) => this.authorizer.recordStreamStart(s, r, st),
        onPacket: (s, r, st, seq, b) => this.authorizer.recordPacketTelemetry(s, r, st, seq, b),
        onStreamStop: (s, r, st) => this.authorizer.recordStreamStop(s, r, st),
        onSessionClose: (s) => this.authorizer.closeSessionTelemetry(s),
        onTranscript: (s, r, text, lang, conf) => this.authorizer.recordPipelineEvent(s, "transcript", r, `[${lang}] conf=${conf.toFixed(2)}: ${text.slice(0, 80)}`),
        onTranslation: (s, r, _src, trans, sLang, tLang, ms) => this.authorizer.recordPipelineEvent(s, "translation", r, `${sLang}->${tLang} (${ms.toFixed(0)}ms): ${trans.slice(0, 80)}`),
        onSynthesized: (s, dest, bytes, ms) => this.authorizer.recordPipelineEvent(s, "synthesized", dest, `TTS ${bytes}B in ${ms.toFixed(0)}ms`),
        onBargeIn: (s, r) => this.authorizer.recordPipelineEvent(s, "barge_in", r, "Barge-in detected, cleared pending audio"),
        onModeChange: (s, mode, lang) => this.authorizer.recordModeChange(s, mode, lang),
        onPlaybackDispatched: (s, dest, bytes) => this.authorizer.recordPipelineEvent(s, "playback_dispatched", dest, `Dispatched ${bytes}B to ${dest}`),
      });
    }
  }

  setAllowlist(allowlist: PilotAllowlist): void {
    if (!allowlist || typeof allowlist !== "object") {
      throw new Error("INVALID_ALLOWLIST");
    }
    if (allowlist.confirmed !== true) {
      throw new Error("ALLOWLIST_CONFIRMATION_REQUIRED");
    }
    const customerNumber = allowlist.customerNumber?.trim();
    const staffNumber = allowlist.staffNumber?.trim();
    if (!customerNumber || !staffNumber) {
      throw new Error("INVALID_ALLOWLIST");
    }
    if (!INDIAN_E164_REGEX.test(customerNumber)) {
      throw new Error("INVALID_CUSTOMER_E164_PHONE");
    }
    if (!INDIAN_E164_REGEX.test(staffNumber)) {
      throw new Error("INVALID_STAFF_E164_PHONE");
    }
    if (customerNumber === staffNumber) {
      throw new Error("DUPLICATE_ALLOWLIST_NUMBERS");
    }
    this.allowlist = {
      customerNumber,
      staffNumber,
      confirmed: true,
    };
  }

  getAllowlist(): PilotAllowlist | undefined {
    return this.allowlist ? { ...this.allowlist } : undefined;
  }

  getStatus() {
    return {
      pilotReady: Boolean(this.allowlist && !this.emergencyStopEngaged),
      emergencyStopEngaged: this.emergencyStopEngaged,
      emergencyStopReason: this.emergencyStopReason || null,
      totalSessionsCreated: this.sessions.size,
      maxSessionsAllowed: this.maxSessions,
      cumulativeEstimatedCostUsd: Number(this.cumulativeEstimatedCostUsd.toFixed(4)),
      maxBudgetUsd: this.maxBudgetUsd,
      maxDurationSeconds: this.maxDurationSeconds,
      activeSessionsCount: Array.from(this.sessions.values()).filter(
        (s) => s.status === "in-progress" || s.status === "pending"
      ).length,
      allowlistConfigured: Boolean(this.allowlist),
      allowlistMasked: this.allowlist
        ? {
            customer: maskPhoneNumber(this.allowlist.customerNumber),
            staff: maskPhoneNumber(this.allowlist.staffNumber),
          }
        : null,
      gates: this.gates,
    };
  }

  async startSession(input: PilotSessionStartInput): Promise<PilotSessionRecord> {
    if (this.emergencyStopEngaged) {
      throw new Error(`PILOT_EMERGENCY_STOP_ACTIVE: ${this.emergencyStopReason}`);
    }

    if (!input.operatorConsent) {
      throw new Error("OPERATOR_CONSENT_REQUIRED");
    }

    if (!input.operatorId?.trim()) {
      throw new Error("OPERATOR_ID_REQUIRED");
    }

    if (!this.allowlist) {
      throw new Error("PILOT_ALLOWLIST_NOT_CONFIGURED");
    }

    const customerInput = input.customerNumber?.trim();
    const staffInput = input.staffNumber?.trim();
    const idempotencyKey = input.idempotencyKey?.trim();

    if (
      customerInput !== this.allowlist.customerNumber ||
      staffInput !== this.allowlist.staffNumber
    ) {
      throw new Error("UNAUTHORIZED_PILOT_PHONE_NUMBER");
    }

    if (idempotencyKey) {
      const existing = this.idempotencySessions.get(idempotencyKey);
      if (existing) {
        return { ...existing };
      }
    }

    if (this.sessions.size >= this.maxSessions) {
      throw new Error("PILOT_SESSION_LIMIT_REACHED");
    }

    const estimatedSessionCost = (this.maxDurationSeconds / 60) * this.estimatedCostPerMinuteUsd;
    if (this.cumulativeEstimatedCostUsd + estimatedSessionCost > this.maxBudgetUsd) {
      throw new Error("PILOT_BUDGET_LIMIT_REACHED");
    }

    // Atomic reservation BEFORE provider call creation
    let reservation: ReservationResult | undefined;
    if (input.authorizationToken) {
      reservation = this.authorizer.reserveAuthorization(
        input.authorizationToken,
        customerInput,
        staffInput,
        this.allowlist,
        idempotencyKey
      );
    }

    let sessionId: string;
    try {
      if (this.orchestrator) {
        const created = await this.orchestrator.create({
          customerNumber: customerInput,
          staffNumber: staffInput,
        });
        sessionId = created.sessionId;
      } else {
        sessionId = `pilot-sim-${randomUUID()}`;
      }
    } catch (error) {
      if (reservation && input.authorizationToken) {
        this.authorizer.failReservation(
          input.authorizationToken,
          reservation.reservationId,
          error instanceof Error ? error.message : "PROVIDER_CALL_CREATION_FAILED"
        );
      }
      throw error;
    }

    if (reservation && input.authorizationToken) {
      this.authorizer.commitAuthorization(
        input.authorizationToken,
        reservation.reservationId,
        sessionId
      );
    }

    const record: PilotSessionRecord = {
      sessionId,
      customerNumberMasked: maskPhoneNumber(customerInput),
      staffNumberMasked: maskPhoneNumber(staffInput),
      operatorId: input.operatorId.trim(),
      startedAt: this.now(),
      estimatedCostUsd: Number(estimatedSessionCost.toFixed(4)),
      status: "in-progress",
      idempotencyKey,
    };

    this.sessions.set(sessionId, record);
    if (idempotencyKey) {
      this.idempotencySessions.set(idempotencyKey, record);
    }
    this.cumulativeEstimatedCostUsd += estimatedSessionCost;

    // Hard duration cap enforcement (180s)
    const timer = setTimeout(async () => {
      await this.terminateSession(sessionId, "HARD_MAX_DURATION_180S_REACHED");
    }, this.maxDurationSeconds * 1000);

    this.activeTimers.set(sessionId, timer);

    return { ...record };
  }

  async terminateSession(sessionId: string, reason = "OPERATOR_TERMINATED"): Promise<PilotSessionRecord> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("PILOT_SESSION_NOT_FOUND");
    }

    const timer = this.activeTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.activeTimers.delete(sessionId);
    }

    if (session.status === "in-progress" || session.status === "pending") {
      session.status = reason.includes("ERROR") || reason.includes("FAIL") ? "failed" : "terminated";
      session.endedAt = this.now();
      session.durationSeconds = Math.max(0, Math.round((session.endedAt - session.startedAt) / 1000));
      session.terminationReason = reason;

      this.authorizer.closeSessionTelemetry(sessionId);

      if (this.orchestrator) {
        try {
          await this.orchestrator.close(sessionId, `pilot-${reason.toLowerCase()}`);
        } catch {
          // session may already be closing
        }
      }
    }

    return { ...session };
  }

  async emergencyStop(reason = "OPERATOR_EMERGENCY_STOP"): Promise<{ terminatedCount: number }> {
    this.emergencyStopEngaged = true;
    this.emergencyStopReason = reason;

    let terminatedCount = 0;
    const activeIds = Array.from(this.sessions.entries())
      .filter(([_, s]) => s.status === "in-progress" || s.status === "pending")
      .map(([id]) => id);

    for (const sessionId of activeIds) {
      await this.terminateSession(sessionId, `EMERGENCY_STOP: ${reason}`);
      terminatedCount++;
    }

    return { terminatedCount };
  }

  resetEmergencyStop(): void {
    this.emergencyStopEngaged = false;
    this.emergencyStopReason = "";
  }

  listSessions(): PilotSessionRecord[] {
    return Array.from(this.sessions.values()).map((s) => ({ ...s }));
  }

  getSession(sessionId: string): PilotSessionRecord | undefined {
    const s = this.sessions.get(sessionId);
    return s ? { ...s } : undefined;
  }

  activateProductionTranslation(): never {
    throw new Error("AUDIO_ISOLATION_UNVERIFIED");
  }
}

export async function registerControlledPilotRoutes(
  app: FastifyInstance,
  options: {
    manager: ControlledPilotManager;
    adminPassword?: string;
  }
): Promise<void> {
  const authorizeAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    const configured = options.adminPassword;
    if (!configured) {
      return reply.code(503).send({ error: "ADMIN_AUTH_UNAVAILABLE" });
    }
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
    const actual = Buffer.from(authorization.slice(7));
    const expected = Buffer.from(configured);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }
  };

  await app.register(async (scoped) => {
    scoped.addHook("preValidation", authorizeAdmin);

    scoped.get("/management/pilot/status", async () => {
      return options.manager.getStatus();
    });

    scoped.post<{ Body: PilotAllowlist }>("/management/pilot/allowlist", { bodyLimit: 2048 }, async (request, reply) => {
      try {
        options.manager.setAllowlist(request.body);
        return { success: true, allowlist: options.manager.getStatus().allowlistMasked };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : "INVALID_ALLOWLIST" });
      }
    });

    scoped.post<{ Body: PilotSessionStartInput }>("/management/pilot/sessions", { bodyLimit: 4096 }, async (request, reply) => {
      try {
        const record = await options.manager.startSession(request.body);
        return reply.code(201).send(record);
      } catch (err) {
        const code = err instanceof Error ? err.message : "PILOT_START_FAILED";
        const status =
          code.includes("UNAUTHORIZED_PILOT") ? 403 :
          code.includes("EMERGENCY_STOP") ? 423 :
          code.includes("LIMIT_REACHED") ? 429 :
          code.includes("REQUIRED") || code.includes("NOT_CONFIGURED") ? 400 : 500;
        return reply.code(status).send({ error: code });
      }
    });

    scoped.get("/management/pilot/sessions", async () => {
      return { sessions: options.manager.listSessions() };
    });

    scoped.get<{ Params: { sessionId: string } }>("/management/pilot/sessions/:sessionId", async (request, reply) => {
      const s = options.manager.getSession(request.params.sessionId);
      if (!s) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
      return s;
    });

    scoped.post<{ Params: { sessionId: string }; Body?: { reason?: string } }>(
      "/management/pilot/sessions/:sessionId/terminate",
      { bodyLimit: 2048 },
      async (request, reply) => {
        try {
          const s = await options.manager.terminateSession(
            request.params.sessionId,
            request.body?.reason ?? "OPERATOR_TERMINATED"
          );
          return s;
        } catch {
          return reply.code(404).send({ error: "SESSION_NOT_FOUND" });
        }
      }
    );

    scoped.post<{ Body: { operatorId: string; operatorConsent: boolean } }>(
      "/management/pilot/authorize",
      { bodyLimit: 2048 },
      async (request, reply) => {
        try {
          const allowlist = options.manager.getAllowlist();
          if (!allowlist) {
            return reply.code(400).send({ error: "PILOT_ALLOWLIST_NOT_CONFIGURED" });
          }
          const auth = options.manager.authorizer.issueAuthorization(
            request.body?.operatorId,
            request.body?.operatorConsent,
            allowlist
          );
          return reply.code(201).send(auth);
        } catch (err) {
          return reply.code(400).send({ error: err instanceof Error ? err.message : "AUTHORIZATION_FAILED" });
        }
      }
    );

    scoped.get<{ Params: { sessionId: string } }>(
      "/management/pilot/telemetry/:sessionId",
      async (request, reply) => {
        const telemetry = options.manager.authorizer.getTelemetry(request.params.sessionId);
        if (!telemetry) return reply.code(404).send({ error: "TELEMETRY_NOT_FOUND" });
        return telemetry;
      }
    );

    scoped.post<{ Body?: { reason?: string } }>("/management/pilot/emergency-stop", { bodyLimit: 2048 }, async (request) => {
      const result = await options.manager.emergencyStop(request.body?.reason ?? "MANUAL_EMERGENCY_STOP");
      return { emergencyStopEngaged: true, ...result };
    });

    scoped.post("/management/pilot/reset-emergency-stop", async () => {
      options.manager.resetEmergencyStop();
      return { emergencyStopEngaged: false };
    });
  });
}

