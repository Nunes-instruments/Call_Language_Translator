import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { maskPhoneNumber, type PilotAllowlist } from "./controlledPilotController.js";

export type AuthorizationStatus = "issued" | "reserved" | "consumed" | "failed";

export interface ReceiveOnlyTelemetryPacket {
  role: "customer" | "staff";
  streamId: string;
  sequenceNumber: number;
  payloadBytes: number;
  timestamp: number;
  codec: "audio/x-mulaw";
  sampleRate: 8000;
  channels: 1;
  packetIntervalMs?: number;
}

export interface ReceiveOnlyStreamTelemetry {
  streamId: string;
  role: "customer" | "staff";
  startedAt: number;
  stoppedAt?: number;
  totalPackets: number;
  totalBytes: number;
  lastSequence: number;
  lastPacketTimestamp?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  averageIntervalMs?: number;
  intervalsCount: number;
  sequenceGaps: number;
}

export interface PipelineEventTelemetry {
  timestamp: number;
  type: "transcript" | "translation" | "synthesized" | "barge_in" | "mode_change" | "echo_suppressed" | "playback_dispatched";
  role?: "customer" | "staff";
  detail: string;
}

export interface ReceiveOnlyPilotSessionTelemetry {
  sessionId: string;
  authorizationTokenMasked: string;
  createdAt: number;
  closedAt?: number;
  customerLeg: ReceiveOnlyStreamTelemetry | null;
  staffLeg: ReceiveOnlyStreamTelemetry | null;
  rawAudioRetained: false;
  transcriptsRetained: false;
  outboundAudioTransmitted: boolean;
  pipelineEvents?: PipelineEventTelemetry[];
  activeMode?: string;
  stableLanguage?: string;
}

export interface SingleUsePilotAuthorization {
  authorizationToken: string;
  authorizationTokenMasked: string;
  operatorId: string;
  issuedAt: number;
  expiresAt: number;
  status: AuthorizationStatus;
  consumed: boolean;
  reservedAt?: number;
  reservationId?: string;
  idempotencyKey?: string;
  consumedAt?: number;
  failedAt?: number;
  failureReason?: string;
  sessionId?: string;
  targetCustomerMasked: string;
  targetStaffMasked: string;
}

export interface ReservationResult {
  reservationId: string;
  authorizationTokenMasked: string;
  operatorId: string;
  expiresAt: number;
}

export class ReceiveOnlyPilotAuthorizer {
  private activeAuthorizations = new Map<string, SingleUsePilotAuthorization>();
  private telemetrySessions = new Map<string, ReceiveOnlyPilotSessionTelemetry>();

  constructor(
    private readonly ttlSeconds = 300,
    private readonly now: () => number = Date.now,
    private readonly storagePath?: string
  ) {
    this.loadState(true);
  }

  private loadState(isServerStartup = false): void {
    if (!this.storagePath) return;
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          let stateMutated = false;
          for (const item of parsed) {
            if (item && item.authorizationToken) {
              const existing = this.activeAuthorizations.get(item.authorizationToken);
              if (item.status === "reserved" && isServerStartup) {
                item.status = "failed";
                item.failedAt = this.now();
                item.failureReason = "SERVER_RESTARTED_DURING_RESERVATION";
                stateMutated = true;
              }
              if (!existing || item.status === "consumed" || item.status === "failed" || item.status === "reserved") {
                this.activeAuthorizations.set(item.authorizationToken, item);
              }
            }
          }
          if (stateMutated) {
            this.persistState();
          }
        }
      }
    } catch {
      // Corrupted file handling: preserve corrupt file for forensics and fail safe
      try {
        if (fs.existsSync(this.storagePath)) {
          const corruptedBackup = `${this.storagePath}.corrupted.${this.now()}`;
          fs.renameSync(this.storagePath, corruptedBackup);
        }
      } catch {
        // ignore backup error
      }
      // Fails safely to fresh in-memory state
    }
  }

  private persistState(): void {
    if (!this.storagePath) return;
    try {
      const records = Array.from(this.activeAuthorizations.values());
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = `${this.storagePath}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2), "utf8");
      try {
        fs.renameSync(tmpPath, this.storagePath);
      } catch {
        try {
          fs.copyFileSync(tmpPath, this.storagePath);
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore
        }
      }
    } catch {
      // Non-fatal persistence error
    }
  }

  issueAuthorization(
    operatorId: string,
    operatorConsent: boolean,
    allowlist: PilotAllowlist
  ): SingleUsePilotAuthorization {
    if (!operatorConsent) {
      throw new Error("OPERATOR_CONSENT_REQUIRED");
    }

    if (!operatorId || !operatorId.trim()) {
      throw new Error("OPERATOR_ID_REQUIRED");
    }

    if (!allowlist || !allowlist.customerNumber || !allowlist.staffNumber) {
      throw new Error("PILOT_ALLOWLIST_REQUIRED");
    }

    // Clean up expired unreserved authorizations
    this.sweep();

    const rawToken = "auth-pilot-" + randomBytes(24).toString("hex");
    const currentTime = this.now();
    const expiresAt = currentTime + this.ttlSeconds * 1000;

    const record: SingleUsePilotAuthorization = {
      authorizationToken: rawToken,
      authorizationTokenMasked: rawToken.slice(0, 15) + "..." + rawToken.slice(-4),
      operatorId: operatorId.trim(),
      issuedAt: currentTime,
      expiresAt,
      status: "issued",
      consumed: false,
      targetCustomerMasked: maskPhoneNumber(allowlist.customerNumber),
      targetStaffMasked: maskPhoneNumber(allowlist.staffNumber),
    };

    this.activeAuthorizations.set(rawToken, record);
    this.persistState();
    return { ...record };
  }

  reserveAuthorization(
    token: string,
    customerNumber: string,
    staffNumber: string,
    configuredAllowlist: PilotAllowlist,
    idempotencyKey?: string
  ): ReservationResult {
    this.loadState();
    this.sweep();

    if (!token || typeof token !== "string") {
      throw new Error("AUTHORIZATION_TOKEN_REQUIRED");
    }

    const auth = this.activeAuthorizations.get(token);
    if (!auth) {
      throw new Error("AUTHORIZATION_TOKEN_INVALID");
    }

    if (auth.status === "consumed" || auth.consumed) {
      throw new Error("AUTHORIZATION_TOKEN_ALREADY_CONSUMED");
    }

    if (auth.status === "failed") {
      throw new Error(`AUTHORIZATION_TOKEN_INVALIDATED: ${auth.failureReason ?? "RESERVATION_FAILED"}`);
    }

    if (auth.status === "reserved") {
      if (idempotencyKey && auth.idempotencyKey === idempotencyKey) {
        return {
          reservationId: auth.reservationId!,
          authorizationTokenMasked: auth.authorizationTokenMasked,
          operatorId: auth.operatorId,
          expiresAt: auth.expiresAt,
        };
      }
      throw new Error("CONCURRENT_TOKEN_USE_DETECTED");
    }

    if (this.now() > auth.expiresAt) {
      throw new Error("AUTHORIZATION_TOKEN_EXPIRED");
    }

    if (
      customerNumber.trim() !== configuredAllowlist.customerNumber.trim() ||
      staffNumber.trim() !== configuredAllowlist.staffNumber.trim()
    ) {
      throw new Error("UNAUTHORIZED_PILOT_PHONE_NUMBER");
    }

    const reservationId = `res-${randomUUID()}`;
    auth.status = "reserved";
    auth.reservedAt = this.now();
    auth.reservationId = reservationId;
    auth.idempotencyKey = idempotencyKey;
    this.persistState();

    return {
      reservationId,
      authorizationTokenMasked: auth.authorizationTokenMasked,
      operatorId: auth.operatorId,
      expiresAt: auth.expiresAt,
    };
  }

  commitAuthorization(
    token: string,
    reservationId: string,
    sessionId: string
  ): SingleUsePilotAuthorization {
    const auth = this.activeAuthorizations.get(token);
    if (!auth) {
      throw new Error("AUTHORIZATION_TOKEN_INVALID");
    }

    if (auth.reservationId !== reservationId) {
      throw new Error("INVALID_RESERVATION_ID");
    }

    if (auth.status === "consumed") {
      return { ...auth };
    }

    if (auth.status !== "reserved") {
      throw new Error("AUTHORIZATION_NOT_RESERVED");
    }

    auth.status = "consumed";
    auth.consumed = true;
    auth.consumedAt = this.now();
    auth.sessionId = sessionId;

    this.telemetrySessions.set(sessionId, {
      sessionId,
      authorizationTokenMasked: auth.authorizationTokenMasked,
      createdAt: this.now(),
      customerLeg: null,
      staffLeg: null,
      rawAudioRetained: false,
      transcriptsRetained: false,
      outboundAudioTransmitted: false,
    });

    this.persistState();
    return { ...auth };
  }

  failReservation(
    token: string,
    reservationId: string,
    reason = "PROVIDER_FAILED"
  ): SingleUsePilotAuthorization {
    const auth = this.activeAuthorizations.get(token);
    if (!auth) {
      throw new Error("AUTHORIZATION_TOKEN_INVALID");
    }

    if (auth.reservationId !== reservationId) {
      throw new Error("INVALID_RESERVATION_ID");
    }

    auth.status = "failed";
    auth.failedAt = this.now();
    auth.failureReason = reason;

    this.persistState();
    return { ...auth };
  }

  consumeAuthorization(
    token: string,
    sessionId: string,
    customerNumber: string,
    staffNumber: string,
    configuredAllowlist: PilotAllowlist,
    idempotencyKey?: string
  ): SingleUsePilotAuthorization {
    const res = this.reserveAuthorization(
      token,
      customerNumber,
      staffNumber,
      configuredAllowlist,
      idempotencyKey
    );
    return this.commitAuthorization(token, res.reservationId, sessionId);
  }

  getAuthorization(token: string): SingleUsePilotAuthorization | undefined {
    this.loadState();
    const a = this.activeAuthorizations.get(token);
    return a ? { ...a } : undefined;
  }

  recordStreamStart(sessionId: string, role: "customer" | "staff", streamId: string): void {
    const session = this.telemetrySessions.get(sessionId);
    if (!session) return;

    const streamTelemetry: ReceiveOnlyStreamTelemetry = {
      streamId,
      role,
      startedAt: this.now(),
      totalPackets: 0,
      totalBytes: 0,
      lastSequence: -1,
      intervalsCount: 0,
      sequenceGaps: 0,
    };

    if (role === "customer") {
      session.customerLeg = streamTelemetry;
    } else {
      session.staffLeg = streamTelemetry;
    }
  }

  recordPacketTelemetry(
    sessionId: string,
    role: "customer" | "staff",
    streamId: string,
    sequenceNumber: number,
    payloadBytes: number
  ): void {
    const session = this.telemetrySessions.get(sessionId);
    if (!session) return;

    const leg = role === "customer" ? session.customerLeg : session.staffLeg;
    if (!leg || leg.streamId !== streamId) return;

    const currentTime = this.now();
    if (leg.lastPacketTimestamp !== undefined) {
      const interval = currentTime - leg.lastPacketTimestamp;
      if (leg.minIntervalMs === undefined || interval < leg.minIntervalMs) {
        leg.minIntervalMs = interval;
      }
      if (leg.maxIntervalMs === undefined || interval > leg.maxIntervalMs) {
        leg.maxIntervalMs = interval;
      }
      const prevTotal = (leg.averageIntervalMs ?? 0) * leg.intervalsCount;
      leg.intervalsCount++;
      leg.averageIntervalMs = Number(((prevTotal + interval) / leg.intervalsCount).toFixed(2));
    }

    if (leg.lastSequence >= 0 && sequenceNumber !== leg.lastSequence + 1) {
      leg.sequenceGaps++;
    }

    leg.lastSequence = sequenceNumber;
    leg.lastPacketTimestamp = currentTime;
    leg.totalPackets++;
    leg.totalBytes += payloadBytes;
  }

  recordStreamStop(sessionId: string, role: "customer" | "staff", streamId: string): void {
    const session = this.telemetrySessions.get(sessionId);
    if (!session) return;

    const leg = role === "customer" ? session.customerLeg : session.staffLeg;
    if (leg && leg.streamId === streamId) {
      leg.stoppedAt = this.now();
    }
  }

  closeSessionTelemetry(sessionId: string): void {
    const session = this.telemetrySessions.get(sessionId);
    if (session) {
      session.closedAt = this.now();
    }
  }

  recordPipelineEvent(
    sessionId: string,
    type: PipelineEventTelemetry["type"],
    role?: "customer" | "staff",
    detail = ""
  ): void {
    const session = this.telemetrySessions.get(sessionId);
    if (!session) return;
    if (!session.pipelineEvents) session.pipelineEvents = [];
    if (session.pipelineEvents.length >= 100) session.pipelineEvents.shift();
    session.pipelineEvents.push({
      timestamp: this.now(),
      type,
      role,
      detail,
    });
    if (type === "playback_dispatched") {
      session.outboundAudioTransmitted = true;
    }
  }

  recordModeChange(sessionId: string, mode: string, language: string): void {
    const session = this.telemetrySessions.get(sessionId);
    if (session) {
      session.activeMode = mode;
      session.stableLanguage = language;
      this.recordPipelineEvent(sessionId, "mode_change", undefined, `${mode}:${language}`);
    }
  }

  getTelemetry(sessionId: string): ReceiveOnlyPilotSessionTelemetry | undefined {
    const s = this.telemetrySessions.get(sessionId);
    return s ? JSON.parse(JSON.stringify(s)) : undefined;
  }

  sweep(): void {
    const currentTime = this.now();
    for (const [token, auth] of this.activeAuthorizations.entries()) {
      // Purge only expired, unconsumed authorizations past TTL + 60s
      if (auth.status === "issued" && currentTime > auth.expiresAt + 60000) {
        this.activeAuthorizations.delete(token);
      }
    }
    this.persistState();
  }
}
