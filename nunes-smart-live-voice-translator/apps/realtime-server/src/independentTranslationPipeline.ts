import { SmartLanguageRouter, detectMixedLanguage, type RouterMode } from "@nunes/language-router";
import { protectEntities, restoreEntities } from "@nunes/translation";
import { decodeMulaw, validAudioBase64 } from "./telephonyAudioCodec.js";
import { providerStage, type SarvamProviders, type PipelineLanguage } from "./sarvamPipelineAdapters.js";
type Role = "customer" | "staff";
const opposite = (role: Role): Role => role === "customer" ? "staff" : "customer";
export interface AudioOwner { sessionId: string; role: Role; callUuid: string; streamId: string; socket: object }
interface Leg { owner: AudioOwner; sequence: number; chunks: Buffer[]; bytes: number; silence: number; speaking: boolean }
interface Prepared { destination: Role; utterance: number; audio: Buffer; generation: number }

export interface TranslationPipelineObserver {
  onTranscript?: (event: { sessionId: string; role: Role; text: string; language: string; confidence: number }) => void;
  onTranslation?: (event: { sessionId: string; role: Role; sourceText: string; translatedText: string; sourceLanguage: PipelineLanguage; targetLanguage: PipelineLanguage; durationMs: number }) => void;
  onSynthesized?: (event: { sessionId: string; destination: Role; audioBytes: number; durationMs: number }) => void;
  onBargeIn?: (event: { sessionId: string; role: Role }) => void;
  onModeChange?: (event: { sessionId: string; mode: RouterMode; language: string }) => void;
  onEchoSuppressed?: (event: { sessionId: string; role: Role }) => void;
  onAudioPrepared?: (event: { sessionId: string; destination: Role; audio: Buffer; utterance: number }) => void;
}

export interface TranslationPipelineOptions {
  timeoutMs?: number;
  customGlossary?: string[];
  allowDirectBypass?: boolean;
  observer?: TranslationPipelineObserver;
}

/** Offline sink deliberately has no socket, transport or provider client. */
export class MockPlaybackSink {
  readonly messages: Array<{ destination: Role; event: string; streamId?: string; media?: { contentType: string; sampleRate: number; payload: string } }> = [];
  record(message: typeof this.messages[number]) { if (this.messages.length >= 32) this.messages.shift(); this.messages.push(message); }
}
/** Only the authenticated orchestrator binds owners. All results are mock-only; live output is structurally absent. */
export class IndependentTranslationPipeline {
  readonly gates = Object.freeze({ documentationContractVerified: true, offlineSimulationIsolation: true, actualAudioIsolationVerified: false, productionTranslationAuthorized: false });
  readonly router = new SmartLanguageRouter("ta");
  readonly metrics = { accepted: 0, held: 0, prepared: 0, cancelled: 0, overflow: 0, echoSuppressed: 0, lastError: "", timings: [] as Array<{ stt: number; translation: number; tts: number; total: number }> };
  private legs: Partial<Record<Role, Leg>> = {};
  private generation = 0;
  private closed = false;
  private utterance = 0;
  private queues: Record<Role, Prepared[]> = { customer: [], staff: [] };
  private pending: Record<Role, number> = { customer: 0, staff: 0 };
  private tails: Record<Role, Promise<void>> = { customer: Promise.resolve(), staff: Promise.resolve() };
  private controllers: Record<Role, Set<AbortController>> = { customer: new Set(), staff: new Set() };
  private echoes: Partial<Record<Role, { audio: Buffer; time: number }>> = {};
  private clears: Record<Role, boolean> = { customer: false, staff: false };
  private readonly timeoutMs: number;
  private readonly customGlossary: string[];
  private readonly allowDirectBypass: boolean;
  private readonly observer?: TranslationPipelineObserver;

  constructor(
    readonly sessionId: string,
    private readonly providers: SarvamProviders,
    optionsOrTimeout: number | TranslationPipelineOptions = 2000
  ) {
    if (providers.mode !== "mock") throw new Error("BILLABLE_SARVAM_BLOCKED");
    if (typeof optionsOrTimeout === "number") {
      this.timeoutMs = optionsOrTimeout;
      this.customGlossary = [];
      this.allowDirectBypass = false;
    } else {
      this.timeoutMs = optionsOrTimeout.timeoutMs ?? 2000;
      this.customGlossary = optionsOrTimeout.customGlossary ?? [];
      this.allowDirectBypass = optionsOrTimeout.allowDirectBypass ?? false;
      this.observer = optionsOrTimeout.observer;
    }
  }
  bind(owner: AudioOwner) {
    if (this.closed || (owner.role !== "customer" && owner.role !== "staff") || owner.sessionId !== this.sessionId || !owner.callUuid || !owner.streamId) throw new Error("INVALID_AUDIO_OWNER");
    const previous = this.legs[owner.role];
    if (previous && this.same(previous.owner, owner)) return;
    if (Object.values(this.legs).some(leg => leg && leg.owner.socket === owner.socket && leg.owner.role !== owner.role)) throw new Error("SOCKET_ALREADY_OWNED");
    this.invalidate();
    if (previous) this.router.reset();
    this.legs[owner.role] = { owner: { ...owner }, sequence: -1, chunks: [], bytes: 0, silence: 0, speaking: false };
  }
  disconnect(role: Role) { delete this.legs[role]; this.invalidate(); this.router.reset(); }
  close() { this.closed = true; this.legs = {}; this.invalidate(); this.echoes = {}; }
  private same(a: AudioOwner, b: AudioOwner) { return a.sessionId === b.sessionId && a.role === b.role && a.callUuid === b.callUuid && a.streamId === b.streamId && a.socket === b.socket; }
  private invalidate() {
    this.generation++;
    this.echoes = {}; this.clears = { customer: false, staff: false };
    for (const role of ["customer", "staff"] as const) {
      for (const controller of this.controllers[role]) controller.abort();
      this.queues[role] = [];
      const leg = this.legs[role]; if (leg) { leg.chunks = []; leg.bytes = 0; leg.silence = 0; leg.speaking = false; }
    }
  }
  receive(owner: AudioOwner, sequence: number, payload: string) {
    const leg = this.legs[owner.role];
    if (this.closed || !leg || !this.same(leg.owner, owner) || !Number.isSafeInteger(sequence) || sequence <= leg.sequence) throw new Error("INVALID_AUDIO_IDENTITY_OR_SEQUENCE");
    const bytes = validAudioBase64(payload, 16000); leg.sequence = sequence;
    const echo = this.echoes[owner.role];
    if (echo && Date.now() - echo.time < 1500 && bytes.equals(echo.audio)) {
      this.metrics.echoSuppressed++;
      this.observer?.onEchoSuppressed?.({ sessionId: this.sessionId, role: owner.role });
      return;
    }
    const pcm = decodeMulaw(bytes);
    const rms = Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / pcm.length);
    const voiced = rms >= 500;
    if (voiced && !leg.speaking) {
      // Barge-in cancels work destined for the speaking leg; no real clearAudio is sent.
      for (const controller of this.controllers[opposite(owner.role)]) controller.abort();
      this.queues[opposite(owner.role)] = [];
      this.clears[opposite(owner.role)] = true;
      leg.speaking = true;
      this.observer?.onBargeIn?.({ sessionId: this.sessionId, role: owner.role });
    }
    if (!leg.speaking) return;
    this.metrics.accepted++; leg.chunks.push(bytes); leg.bytes += bytes.length;
    leg.silence = voiced ? 0 : leg.silence + bytes.length;
    if (leg.silence >= 2400 || leg.bytes >= 32000) this.flush(owner.role);
  }
  flush(role: Role) {
    const leg = this.legs[role]; if (!leg?.bytes) return;
    const audio = Buffer.concat(leg.chunks); leg.chunks = []; leg.bytes = 0; leg.silence = 0; leg.speaking = false;
    if (audio.length < 800 || !this.legs[opposite(role)]) { this.metrics.held++; return; }
    if (this.pending[role] >= 4) { this.metrics.overflow++; this.invalidate(); return; }
    const generation = this.generation, utterance = ++this.utterance, controller = new AbortController();
    this.controllers[role].add(controller); this.pending[role]++;
    this.tails[role] = this.tails[role].then(async () => {
      if (controller.signal.aborted || generation !== this.generation) return;
      await this.process(role, audio, utterance, generation, controller);
    }).catch(() => { this.metrics.lastError = "PIPELINE_FAILURE"; }).finally(() => { this.controllers[role].delete(controller); this.pending[role]--; });
  }
  private async process(role: Role, audio: Buffer, utterance: number, generation: number, controller: AbortController) {
    const began = performance.now(); const timings = { stt: 0, translation: 0, tts: 0, total: 0 };
    const stage = async <T>(name: "stt" | "translation" | "tts", operation: (signal: AbortSignal) => Promise<T>) => {
      const start = performance.now(); try { return await providerStage(operation, controller.signal, this.timeoutMs); } finally { timings[name] += performance.now() - start; }
    };
    try {
      const transcript = await stage("stt", signal => this.providers.transcribe(decodeMulaw(audio), signal));
      if (!transcript.final || !transcript.text.trim() || transcript.text.length > 2000 || !Number.isFinite(transcript.confidence)) { this.metrics.held++; return; }
      const detected = detectMixedLanguage(transcript.text, transcript.language, transcript.confidence);
      if (detected.language === "unknown" || transcript.confidence < .72) { this.metrics.held++; return; }
      this.observer?.onTranscript?.({ sessionId: this.sessionId, role, text: transcript.text, language: transcript.language ?? detected.language, confidence: transcript.confidence });
      if (role === "customer") {
        const decision = this.router.observe(detected.language, transcript.confidence);
        this.observer?.onModeChange?.({ sessionId: this.sessionId, mode: decision.mode, language: decision.stableLanguage });
      }
      if (this.router.getMode() === "DIRECT_BYPASS") {
        if (!this.allowDirectBypass) {
          this.metrics.lastError = "ORIGINAL_AUDIO_PATH_UNVERIFIED";
          this.metrics.held++;
          return;
        }
        const queue = this.queues[role];
        if (queue.length >= 4) { this.metrics.overflow++; this.invalidate(); return; }
        queue.push({ destination: opposite(role), audio: Buffer.from(audio), generation, utterance });
        this.metrics.prepared++;
        this.observer?.onAudioPrepared?.({ sessionId: this.sessionId, destination: opposite(role), audio, utterance });
        return;
      }
      if (this.router.getStableLanguage() !== "hi" || (role === "staff" && detected.language !== "ta") || (role === "customer" && detected.language !== "hi")) { this.metrics.held++; return; }
      if (/NUNESENTITY\d*/i.test(transcript.text)) throw new Error("ENTITY_TOKEN_COLLISION");
      const protectedText = protectEntities(transcript.text, this.customGlossary);
      const source = role === "customer" ? "hi-IN" : "ta-IN", target = role === "customer" ? "ta-IN" : "hi-IN";
      const translated = await stage("translation", signal => this.providers.translate(protectedText.text, source, target, signal));
      const tokens = translated.match(/NUNESENTITY\d+/gi) ?? [];
      if (tokens.length !== protectedText.entities.length || protectedText.entities.some(entity => tokens.filter(token => token.toUpperCase() === entity.token).length !== 1)) throw new Error("ENTITY_INTEGRITY_FAILED");
      const restored = restoreEntities(translated, protectedText.entities);
      this.observer?.onTranslation?.({ sessionId: this.sessionId, role, sourceText: transcript.text, translatedText: restored, sourceLanguage: source, targetLanguage: target, durationMs: timings.translation });
      const result = await stage("tts", signal => this.providers.synthesize(restored, target, signal));
      controller.signal.throwIfAborted();
      if (generation !== this.generation || this.closed || !this.legs[opposite(role)]) return;
      if (result.encoding !== "audio/x-mulaw" || result.sampleRate !== 8000 || !result.audio.length || result.audio.length > 80000) throw new Error("INVALID_TTS_AUDIO");
      const queue = this.queues[role];
      if (queue.length >= 4 || queue.reduce((total, item) => total + item.audio.length, 0) + result.audio.length > 128000) { this.metrics.overflow++; this.invalidate(); return; }
      const preparedBuffer = Buffer.from(result.audio);
      queue.push({ destination: opposite(role), audio: preparedBuffer, generation, utterance });
      this.metrics.prepared++;
      this.observer?.onSynthesized?.({ sessionId: this.sessionId, destination: opposite(role), audioBytes: preparedBuffer.length, durationMs: timings.tts });
      this.observer?.onAudioPrepared?.({ sessionId: this.sessionId, destination: opposite(role), audio: preparedBuffer, utterance });
    } catch (error) {
      if (controller.signal.aborted) this.metrics.cancelled++;
      else this.metrics.lastError = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "PROVIDER_FAILURE";
    } finally { timings.total = performance.now() - began; if (this.metrics.timings.length >= 32) this.metrics.timings.shift(); this.metrics.timings.push(timings); }
  }
  async idle() { await Promise.all([this.tails.customer, this.tails.staff]); }
  drainMock(role: Role, sink: MockPlaybackSink, authorization: { offlineTranslationAuthorized: boolean; simulatedIsolationVerified: boolean }) {
    if (!authorization.offlineTranslationAuthorized || !authorization.simulatedIsolationVerified) throw new Error("OFFLINE_PLAYBACK_GATE_CLOSED");
    if (this.closed) throw new Error("SESSION_CLOSED");
    if (this.clears[role] && this.legs[opposite(role)]) { sink.record({ destination: opposite(role), event: "clearAudio", streamId: this.legs[opposite(role)]!.owner.streamId }); this.clears[role] = false; }
    for (const item of this.queues[role].splice(0)) {
      if (item.generation !== this.generation) continue;
      sink.record({ destination: item.destination, event: "playAudio", media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: item.audio.toString("base64") } });
      this.echoes[item.destination] = { audio: item.audio, time: Date.now() };
    }
  }
  drainFieldVerification(
    role: Role,
    sink: MockPlaybackSink,
    authorization: {
      operatorConsent: boolean;
      operatorId: string;
      allowlistVerified: boolean;
      sessionDurationCapped: boolean;
      auditToken: string;
    }
  ) {
    if (
      !authorization ||
      !authorization.operatorConsent ||
      !authorization.operatorId?.trim() ||
      !authorization.allowlistVerified ||
      !authorization.sessionDurationCapped ||
      !authorization.auditToken?.trim()
    ) {
      throw new Error("FIELD_VERIFICATION_GATE_CLOSED");
    }
    if (this.closed) throw new Error("SESSION_CLOSED");
    if (this.clears[role] && this.legs[opposite(role)]) {
      sink.record({ destination: opposite(role), event: "clearAudio", streamId: this.legs[opposite(role)]!.owner.streamId });
      this.clears[role] = false;
    }
    for (const item of this.queues[role].splice(0)) {
      if (item.generation !== this.generation) continue;
      sink.record({ destination: item.destination, event: "playAudio", media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: item.audio.toString("base64") } });
      this.echoes[item.destination] = { audio: item.audio, time: Date.now() };
    }
  }
  productionPlayback(): never { throw new Error("AUDIO_ISOLATION_UNVERIFIED"); }
  get queued() { return { customerToStaff: this.queues.customer.length, staffToCustomer: this.queues.staff.length }; }
}
