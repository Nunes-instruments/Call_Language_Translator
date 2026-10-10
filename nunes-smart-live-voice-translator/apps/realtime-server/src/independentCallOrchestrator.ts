import { randomBytes, timingSafeEqual } from "node:crypto";
import { IndependentLiveCallManager, type IndependentLiveCallStart } from "./independentLiveCallManager.js";
import type { CallLegRole } from "./independentCallSessionEngine.js";
import { buildIndependentCallLegUrls } from "./independentCallLegUrls.js";
import { buildIndependentCallLegXml } from "./independentCallLegXml.js";
import { IndependentCallbackReplay } from "./independentCallbackReplay.js";
import type { IndependentCallProvider } from "./independentCallProvider.js";
import { IndependentTranslationPipeline } from "./independentTranslationPipeline.js";
import type { SarvamProviders } from "./sarvamPipelineAdapters.js";
import type { ManagementStore } from "../../../packages/database/src/managementStore.js";

const roles = ["customer", "staff"] as const;
export interface IndependentSocket { close(code?: number, reason?: string): void; readonly readyState?: number }
interface Pipeline { frames: number; bytes: number; lastSequence: number; disconnectedAt?: number }
interface Runtime {
  translation?: IndependentTranslationPipeline;
  createdAt: number;
  closedAt?: number;
  closeReason?: string;
  tokens: Record<CallLegRole, string>;
  pipelines: Record<CallLegRole, Pipeline>;
  retiredStreams: Set<string>;
  cleanupPending: Set<CallLegRole>;
  cleanupAttempts: number;
  cleanup?: Promise<void>;
  creating: boolean;
  resources: Partial<Record<CallLegRole, string>>;
}
interface Binding { socket: IndependentSocket; openedAt: number; streamId?: string; started: boolean }
export interface IndependentOrchestratorOptions {
  store?: ManagementStore;
  offlineTranslationProviders?: SarvamProviders;
  customGlossary?: string[];
  allowDirectBypass?: boolean;
  dispatchOfflinePlayback?: boolean;
  publicBaseUrl: string;
  fromNumber: string;
  provider: IndependentCallProvider;
  manager?: IndependentLiveCallManager;
  now?: () => number;
  maxDurationMs?: number;
  reconnectGraceMs?: number;
  closedRetentionMs?: number;
  startTimeoutMs?: number;
}

export interface IndependentTelemetryListener {
  onStreamStart?(sessionId: string, role: CallLegRole, streamId: string): void;
  onPacket?(sessionId: string, role: CallLegRole, streamId: string, sequenceNumber: number, payloadBytes: number): void;
  onStreamStop?(sessionId: string, role: CallLegRole, streamId: string): void;
  onSessionClose?(sessionId: string): void;
  onTranscript?(sessionId: string, role: CallLegRole, text: string, language: string, confidence: number): void;
  onTranslation?(sessionId: string, role: CallLegRole, sourceText: string, translatedText: string, sourceLanguage: string, targetLanguage: string, durationMs: number): void;
  onSynthesized?(sessionId: string, destination: CallLegRole, audioBytes: number, durationMs: number): void;
  onBargeIn?(sessionId: string, role: CallLegRole): void;
  onModeChange?(sessionId: string, mode: string, language: string): void;
  onPlaybackDispatched?(sessionId: string, destination: CallLegRole, audioBytes: number): void;
}

/** Two independent receive-only pipelines. There is intentionally no audio output API. */
export class IndependentCallOrchestrator {
  readonly manager: IndependentLiveCallManager;
  readonly replay = new IndependentCallbackReplay();
  readonly audioIsolationVerified = false as const;
  readonly translationEnabled = false as const;
  private readonly runtime = new Map<string, Runtime>();
  private readonly sockets = new Map<string, Binding>();
  private readonly socketOwners = new WeakMap<IndependentSocket, string>();
  private readonly now: () => number;
  private disposed = false;
  private telemetryListener?: IndependentTelemetryListener;

  setTelemetryListener(listener?: IndependentTelemetryListener): void {
    this.telemetryListener = listener;
  }

  constructor(readonly options: IndependentOrchestratorOptions) {
    this.manager = options.manager ?? new IndependentLiveCallManager();
    this.now = options.now ?? Date.now;
    // Validate before any provider operation or route registration.
    buildIndependentCallLegUrls(options.publicBaseUrl, "configuration-check", "customer");
    if (!/^\+?[1-9]\d{6,14}$/.test(options.fromNumber)) throw new Error("INVALID_FROM_NUMBER");
    if (options.offlineTranslationProviders && options.offlineTranslationProviders.mode !== "mock") throw new Error("BILLABLE_SARVAM_BLOCKED");
  }

  async create(input: IndependentLiveCallStart) {
    if (this.disposed) throw new Error("ORCHESTRATOR_CLOSED");
    if (this.options.provider.mode !== "offline") throw new Error("LIVE_CALL_APPROVAL_REQUIRED");
    for (const number of [input.customerNumber, input.staffNumber]) {
      if (typeof number !== "string" || !/^\+?[1-9]\d{6,14}$/.test(number)) throw new Error("INVALID_DESTINATION_NUMBER");
    }
    if (input.customerNumber.replace(/^\+/, "") === input.staffNumber.replace(/^\+/, "")) throw new Error("DISTINCT_LEGS_REQUIRED");
    const record = this.manager.create(input);
    const runtime: Runtime = {
      createdAt: this.now(), tokens: { customer: randomBytes(32).toString("base64url"), staff: randomBytes(32).toString("base64url") },
      pipelines: { customer: { frames: 0, bytes: 0, lastSequence: -1 }, staff: { frames: 0, bytes: 0, lastSequence: -1 } },
      retiredStreams: new Set(), cleanupPending: new Set(), cleanupAttempts: 0, creating: true, resources: {},
    };
    this.runtime.set(record.sessionId, runtime);
    if (this.options.offlineTranslationProviders) {
      runtime.translation = new IndependentTranslationPipeline(record.sessionId, this.options.offlineTranslationProviders, {
        customGlossary: this.options.customGlossary,
        allowDirectBypass: this.options.allowDirectBypass,
        observer: {
          onTranscript: (e) => this.telemetryListener?.onTranscript?.(e.sessionId, e.role, e.text, e.language, e.confidence),
          onTranslation: (e) => this.telemetryListener?.onTranslation?.(e.sessionId, e.role, e.sourceText, e.translatedText, e.sourceLanguage, e.targetLanguage, e.durationMs),
          onSynthesized: (e) => this.telemetryListener?.onSynthesized?.(e.sessionId, e.destination, e.audioBytes, e.durationMs),
          onBargeIn: (e) => {
            this.clearPlayback(e.sessionId, e.role);
            this.telemetryListener?.onBargeIn?.(e.sessionId, e.role);
          },
          onModeChange: (e) => this.telemetryListener?.onModeChange?.(e.sessionId, e.mode, e.language),
          onAudioPrepared: (e) => {
            this.dispatchPlayback(e.sessionId, e.destination, e.audio);
          },
        },
      });
    }
    try {
      await this.options.store?.beginSession(record.sessionId,input.staffNumber);
      for (const role of roles) {
        if (this.disposed || this.manager.getSession(record.sessionId)?.closed) throw new Error("SESSION_CLOSED_DURING_CREATE");
        const urls = buildIndependentCallLegUrls(this.options.publicBaseUrl, record.sessionId, role);
        const result = await this.options.provider.createLeg({
          sessionId: record.sessionId, role, from: this.options.fromNumber,
          to: role === "customer" ? input.customerNumber : input.staffNumber,
          answerUrl: urls.answerUrl, hangupUrl: urls.completedUrl,
        });
        // Provider request UUID is stored independently of the eventual call UUID.
        if (this.manager.getSession(record.sessionId)?.closed) {
          // The create result may arrive after cancellation/shutdown. Retain teardown ownership
          // even though the closed manager correctly refuses a new call binding.
          if (typeof result.requestUuid !== "string" || !result.requestUuid.trim()) throw new Error("INVALID_PROVIDER_RESPONSE");
          runtime.resources[role] = result.requestUuid;
          runtime.cleanupPending.add(role);
          await this.close(record.sessionId, "closed-during-create");
          throw new Error("SESSION_CLOSED_DURING_CREATE");
        }
        this.manager.expectRequest(record.sessionId, role, result.requestUuid);
        runtime.resources[role] = result.requestUuid;
        runtime.cleanupPending.add(role);
        await this.persist(record.sessionId,"provider.request.created");
      }
      return this.describe(record.sessionId);
    } catch {
      await this.close(record.sessionId, "provider-failure");
      throw new Error("INDEPENDENT_PROVIDER_CREATE_FAILED");
    } finally {
      runtime.creating = false;
    }
  }

  describe(sessionId: string) {
    const session = this.manager.getSession(sessionId);
    const record = this.manager.get(sessionId);
    const runtime = this.runtime.get(sessionId);
    if (!session || !record || !runtime) throw new Error("SESSION_NOT_FOUND");
    return {
      sessionId, state: record.state, closeReason: runtime.closeReason,
      cleanupPending: runtime.closedAt !== undefined && runtime.cleanupPending.size > 0,
      audioIsolationVerified: false, translationEnabled: false, providerMode: this.options.provider.mode,
      offlineTranslation: runtime.translation ? { gates: runtime.translation.gates, queued: runtime.translation.queued, metrics: runtime.translation.metrics } : null,
      customer: this.describeLeg(sessionId, "customer"), staff: this.describeLeg(sessionId, "staff"),
    };
  }

  private describeLeg(sessionId: string, role: CallLegRole) {
    const session = this.manager.getSession(sessionId)!;
    const runtime = this.runtime.get(sessionId)!;
    return {
      requestUuid: this.manager.expectedRequest(sessionId, role) ?? null,
      callUuid: session[role].callUuid, streamId: session[role].streamId,
      answered: session[role].connected, socketConnected: Boolean(this.sockets.get(`${sessionId}:${role}`)?.started),
      frames: runtime.pipelines[role].frames, bytes: runtime.pipelines[role].bytes,
    };
  }

  answerXml(sessionId: string, role: CallLegRole): string {
    const runtime = this.requireOpen(sessionId);
    const leg = this.manager.getSession(sessionId)![role];
    if (!leg.connected || !leg.callUuid) throw new Error("LEG_NOT_ANSWERED");
    return buildIndependentCallLegXml({ sessionId, role, publicBaseUrl: this.options.publicBaseUrl, connectionToken: runtime.tokens[role] });
  }

  authorizeUpgrade(sessionId: string, role: CallLegRole, token: string): void {
    const runtime = this.requireOpen(sessionId);
    const expected = Buffer.from(runtime.tokens[role]);
    const actual = Buffer.from(token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("STREAM_TOKEN_MISMATCH");
    if (!this.manager.expectedRequest(sessionId, role) || !this.manager.getSession(sessionId)![role].connected) throw new Error("LEG_NOT_ANSWERED");
    const binding = this.sockets.get(`${sessionId}:${role}`);
    if (binding && binding.socket.readyState !== undefined && binding.socket.readyState >= 2) {
      this.disconnectSocket(sessionId, role, binding.socket);
    }
    if (this.sockets.has(`${sessionId}:${role}`)) throw new Error("DUPLICATE_SOCKET_OWNER");
  }

  openSocket(sessionId: string, role: CallLegRole, token: string, socket: IndependentSocket): void {
    this.authorizeUpgrade(sessionId, role, token);
    if (this.socketOwners.has(socket)) throw new Error("SOCKET_ALREADY_OWNED");
    this.socketOwners.set(socket, `${sessionId}:${role}`);
    this.sockets.set(`${sessionId}:${role}`, { socket, openedAt: this.now(), started: false });
  }

  startSocket(sessionId: string, role: CallLegRole, socket: IndependentSocket, start: unknown): void {
    const runtime = this.requireOpen(sessionId);
    const binding = this.requireSocket(sessionId, role, socket);
    if (binding.streamId || !start || typeof start !== "object") throw new Error("INVALID_STREAM_START");
    const data = start as { callId?: unknown; streamId?: unknown; tracks?: unknown; mediaFormat?: { encoding?: unknown; sampleRate?: unknown } };
    const leg = this.manager.getSession(sessionId)![role];
    if (data.callId !== leg.callUuid || typeof data.streamId !== "string" || !data.streamId.trim() || data.streamId.length > 128 ||
      data.mediaFormat?.encoding !== "audio/x-mulaw" || data.mediaFormat.sampleRate !== 8000 ||
      !Array.isArray(data.tracks) || data.tracks.length !== 1 || data.tracks[0] !== "inbound" || runtime.retiredStreams.has(data.streamId)) {
      throw new Error("STREAM_OWNERSHIP_OR_FORMAT_MISMATCH");
    }
    if (leg.streamId && leg.streamId !== data.streamId) throw new Error("STREAM_ID_MISMATCH");
    binding.streamId = data.streamId;
    // WebSocket message alone cannot establish stream ownership. Wait for signed HTTP status.
    binding.started = leg.streamId === data.streamId;
    if (binding.started) {
      runtime.pipelines[role].lastSequence = -1;
      runtime.pipelines[role].disconnectedAt = undefined;
      this.bindTranslation(sessionId, role, binding);
      this.telemetryListener?.onStreamStart?.(sessionId, role, data.streamId);
    }
  }

  assertStreamAllowed(sessionId: string, role: CallLegRole, streamId: string): void {
    const runtime = this.requireOpen(sessionId);
    if (runtime.retiredStreams.has(streamId)) throw new Error("RETIRED_STREAM_REPLAY");
    const leg = this.manager.getSession(sessionId)![role];
    if (!leg.streamId && runtime.retiredStreams.size >= 256) throw new Error("STREAM_GENERATION_CAPACITY_EXCEEDED");
    if (leg.streamId && leg.streamId !== streamId) throw new Error("STREAM_ALREADY_ATTACHED");
  }

  streamStarted(sessionId: string, role: CallLegRole, streamId: string): void {
    const runtime = this.requireOpen(sessionId);
    const binding = this.sockets.get(`${sessionId}:${role}`);
    if (binding?.streamId) {
      if (binding.streamId !== streamId) {
        this.disconnectSocket(sessionId, role, binding.socket);
        binding.socket.close(1008, "Stream ownership mismatch");
        return;
      }
      if (!binding.started) runtime.pipelines[role].lastSequence = -1;
      binding.started = true;
      runtime.pipelines[role].disconnectedAt = undefined;
      this.bindTranslation(sessionId, role, binding);
      this.telemetryListener?.onStreamStart?.(sessionId, role, streamId);
    }
  }

  streamStopped(sessionId: string, role: CallLegRole, streamId: string): void {
    const runtime = this.requireOpen(sessionId);
    if (runtime.retiredStreams.size >= 256 && !runtime.retiredStreams.has(streamId)) throw new Error("STREAM_GENERATION_CAPACITY_EXCEEDED");
    runtime.retiredStreams.add(streamId);
    runtime.translation?.disconnect(role);
    runtime.pipelines[role].disconnectedAt = this.now();
    this.telemetryListener?.onStreamStop?.(sessionId, role, streamId);
    const binding = this.sockets.get(`${sessionId}:${role}`);
    if (binding?.streamId === streamId) {
      this.sockets.delete(`${sessionId}:${role}`);
      binding.socket.close(1000, "Stream stopped");
    }
  }

  isRetiredStream(sessionId: string, streamId: string): boolean {
    return this.runtime.get(sessionId)?.retiredStreams.has(streamId) ?? false;
  }

  media(sessionId: string, role: CallLegRole, socket: IndependentSocket, message: unknown): boolean {
    const runtime = this.requireOpen(sessionId);
    const binding = this.requireSocket(sessionId, role, socket);
    if (!binding.started) return false; // No buffering/forwarding during callback/start races.
    const data = message as { streamId?: unknown; sequenceNumber?: unknown; media?: { track?: unknown; payload?: unknown } };
    const pipeline = runtime.pipelines[role];
    if (!data || data.streamId !== binding.streamId || data.streamId !== this.manager.getSession(sessionId)![role].streamId ||
      data.media?.track !== "inbound" || typeof data.media.payload !== "string" || data.media.payload.length > 22000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.media.payload) || !data.media.payload.length ||
      typeof data.sequenceNumber !== "number" || !Number.isSafeInteger(data.sequenceNumber) || data.sequenceNumber <= pipeline.lastSequence) {
      throw new Error("INVALID_MEDIA_IDENTITY_OR_SEQUENCE");
    }
    pipeline.lastSequence = data.sequenceNumber;
    pipeline.frames++;
    const payloadBytes = Buffer.from(data.media.payload, "base64").length;
    pipeline.bytes += payloadBytes;
    this.telemetryListener?.onPacket?.(sessionId, role, binding.streamId!, data.sequenceNumber, payloadBytes);
    runtime.translation?.receive({ sessionId, role, socket, callUuid: this.manager.getSession(sessionId)![role].callUuid!, streamId: binding.streamId! }, data.sequenceNumber, data.media.payload);
    return true;
  }

  disconnectSocket(sessionId: string, role: CallLegRole, socket: IndependentSocket): boolean {
    const key = `${sessionId}:${role}`;
    if (this.sockets.get(key)?.socket !== socket) return false;
    this.sockets.delete(key);
    const runtime = this.runtime.get(sessionId);
    if (runtime) runtime.pipelines[role].disconnectedAt = this.now();
    runtime?.translation?.disconnect(role);
    return true;
  }

  async close(sessionId: string, reason: string): Promise<void> {
    const runtime = this.runtime.get(sessionId);
    if (!runtime) return;
    if (runtime.closedAt === undefined) {
      runtime.closedAt = this.now();
      runtime.closeReason = reason;
      runtime.translation?.close();
      this.manager.close(sessionId);
      this.telemetryListener?.onSessionClose?.(sessionId);
      for (const role of roles) {
        const key = `${sessionId}:${role}`;
        const binding = this.sockets.get(key);
        this.sockets.delete(key);
        binding?.socket.close(1000, "Session closed");
      }
    }
    if (runtime.cleanup) return runtime.cleanup;
    if (this.options.store) { try { await this.persist(sessionId,"session.closed","closed"); } catch { /* Provider teardown still runs during database outage. */ } }
    runtime.cleanupAttempts++;
    runtime.cleanup = (async () => {
      for (const role of [...runtime.cleanupPending]) {
        try {
          const requestUuid = runtime.resources[role]!;
          await this.options.provider.stopLeg({ requestUuid, callUuid: this.manager.getSession(sessionId)?.[role].callUuid ?? null });
          runtime.cleanupPending.delete(role);
        } catch { /* Retain bounded failed-cleanup state. Never report successful teardown. */ }
      }
    })();
    try { await runtime.cleanup; } finally { runtime.cleanup = undefined; }
  }

  async sweep(): Promise<void> {
    const now = this.now();
    for (const [sessionId, runtime] of this.runtime) {
      if (runtime.closedAt !== undefined) {
        if (runtime.cleanupPending.size && runtime.cleanupAttempts < 5) await this.close(sessionId, runtime.closeReason ?? "cleanup-retry");
        if (!runtime.creating && !runtime.cleanupPending.size && now - runtime.closedAt >= (this.options.closedRetentionMs ?? 60_000)) {
          this.manager.removeClosed(sessionId);
          this.replay.forgetSession(sessionId);
          this.runtime.delete(sessionId);
        }
        continue;
      }
      if (now - runtime.createdAt >= (this.options.maxDurationMs ?? 30 * 60_000)) {
        await this.close(sessionId, "session-timeout");
        continue;
      }
      for (const role of roles) {
        let binding = this.sockets.get(`${sessionId}:${role}`);
        if (binding && binding.socket.readyState !== undefined && binding.socket.readyState >= 2) {
          this.disconnectSocket(sessionId, role, binding.socket);
          binding = undefined;
        }
        if (binding && !binding.started && now - binding.openedAt >= (this.options.startTimeoutMs ?? 10_000)) {
          await this.close(sessionId, "stream-start-timeout");
          break;
        }
        const disconnectedAt = runtime.pipelines[role].disconnectedAt;
        if (disconnectedAt !== undefined && now - disconnectedAt >= (this.options.reconnectGraceMs ?? 30_000)) {
          await this.close(sessionId, "reconnect-timeout");
          break;
        }
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const sessionId of this.runtime.keys()) await this.close(sessionId, "server-shutdown");
  }
  forwardAudio(): never { throw new Error("AUDIO_ISOLATION_UNVERIFIED"); }
  enableTranslation(): never { throw new Error("AUDIO_ISOLATION_UNVERIFIED"); }
  dispatchPlayback(sessionId: string, destination: CallLegRole, payload: Buffer): boolean {
    if (this.options.provider.mode === "offline") {
      if (!this.options.dispatchOfflinePlayback) return false;
    } else if (!this.audioIsolationVerified) {
      return false;
    }
    const binding = this.sockets.get(`${sessionId}:${destination}`);
    if (binding?.socket && binding.started && binding.streamId) {
      const message = JSON.stringify({
        event: "playAudio",
        streamId: binding.streamId,
        media: {
          contentType: "audio/x-mulaw",
          sampleRate: 8000,
          payload: payload.toString("base64"),
        },
      });
      if (typeof (binding.socket as any).send === "function") {
        (binding.socket as any).send(message);
        this.telemetryListener?.onPlaybackDispatched?.(sessionId, destination, payload.length);
        return true;
      }
    }
    return false;
  }

  clearPlayback(sessionId: string, destination: CallLegRole): boolean {
    if (this.options.provider.mode === "offline") {
      if (!this.options.dispatchOfflinePlayback) return false;
    } else if (!this.audioIsolationVerified) {
      return false;
    }
    const binding = this.sockets.get(`${sessionId}:${destination}`);
    if (binding?.socket && binding.started && binding.streamId) {
      const message = JSON.stringify({
        event: "clearAudio",
        streamId: binding.streamId,
      });
      if (typeof (binding.socket as any).send === "function") {
        (binding.socket as any).send(message);
        return true;
      }
    }
    return false;
  }
  get sessionCount(): number { return this.runtime.size; }
  get socketCount(): number { return this.sockets.size; }
  async persist(sessionId: string, event = "state.changed", eventKey?: string) { await this.options.store?.snapshot(this.describe(sessionId),event,eventKey); }
  private bindTranslation(sessionId: string, role: CallLegRole, binding: Binding) {
    this.runtime.get(sessionId)?.translation?.bind({ sessionId, role, socket: binding.socket, streamId: binding.streamId!, callUuid: this.manager.getSession(sessionId)![role].callUuid! });
  }

  private requireOpen(sessionId: string): Runtime {
    const runtime = this.runtime.get(sessionId);
    if (this.disposed || !runtime || this.manager.getSession(sessionId)?.closed) throw new Error("SESSION_NOT_OPEN");
    return runtime;
  }
  private requireSocket(sessionId: string, role: CallLegRole, socket: IndependentSocket): Binding {
    const binding = this.sockets.get(`${sessionId}:${role}`);
    if (!binding || binding.socket !== socket) throw new Error("SOCKET_OWNERSHIP_MISMATCH");
    return binding;
  }
}
