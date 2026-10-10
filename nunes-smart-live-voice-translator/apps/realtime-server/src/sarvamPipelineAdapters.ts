import { pcm16Wav, validAudioBase64, wavToPlivoMulaw } from "./telephonyAudioCodec.js";
export type PipelineLanguage = "hi-IN" | "ta-IN";
export interface Transcript { text: string; language: string | null; confidence: number; final: boolean }
export interface SarvamProviders {
  readonly mode: "mock" | "live";
  transcribe(pcm: Int16Array, signal: AbortSignal): Promise<Transcript>;
  translate(text: string, source: PipelineLanguage, target: PipelineLanguage, signal: AbortSignal): Promise<string>;
  synthesize(text: string, target: PipelineLanguage, signal: AbortSignal): Promise<{ audio: Buffer; encoding: "audio/x-mulaw"; sampleRate: 8000 }>;
}
export interface SarvamRequest {
  endpoint: "/speech-to-text" | "/translate" | "/text-to-speech";
  fields: Record<string, unknown>;
  file?: { name: string; contentType: "audio/wav"; bytes: Buffer };
}
export interface SarvamTransport {
  readonly mode: "mock" | "live";
  request(request: SarvamRequest, signal: AbortSignal): Promise<unknown>;
}
export class ProviderFailure extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); }
}
export interface SarvamAdapterConfig {
  sttModel?: "saaras:v4";
  translationModel?: "sarvam-translate:v1";
  ttsModel?: "bulbul:v3";
  speaker?: string;
  keyterms?: string[];
}
/** Contract-shaped adapters; Phase 3 permits only injected mock transports. No fetch/client/key exists here. */
export class SarvamContractAdapters implements SarvamProviders {
  readonly mode = "mock" as const;
  private readonly config: Required<SarvamAdapterConfig>;
  constructor(private readonly transport: SarvamTransport, config: SarvamAdapterConfig = {}) {
    if (transport.mode !== "mock") throw new Error("BILLABLE_SARVAM_BLOCKED");
    this.config = { sttModel: "saaras:v4", translationModel: "sarvam-translate:v1", ttsModel: "bulbul:v3", speaker: "shubh", keyterms: ["Fluke", "GE Druck", "pressure calibrator", "GST"], ...config };
    if (this.config.sttModel !== "saaras:v4" || this.config.translationModel !== "sarvam-translate:v1" || this.config.ttsModel !== "bulbul:v3" || this.config.keyterms.length > 50 || this.config.keyterms.some(term => term.length > 64)) throw new Error("INVALID_PROVIDER_CONFIG");
  }
  async transcribe(pcm: Int16Array, signal: AbortSignal): Promise<Transcript> {
    if (!pcm.length || pcm.length > 8000 * 10) throw new ProviderFailure("INVALID_UTTERANCE_AUDIO");
    const result = await this.transport.request({ endpoint: "/speech-to-text", fields: {
      model: this.config.sttModel, mode: "codemix", language_code: "unknown", keyterms: JSON.stringify(this.config.keyterms),
    }, file: { name: "utterance.wav", contentType: "audio/wav", bytes: pcm16Wav(pcm) } }, signal) as { transcript?: unknown; language_code?: unknown; language_probability?: unknown };
    if (!result || typeof result.transcript !== "string" || result.transcript.length > 2000) throw new ProviderFailure("INVALID_STT_RESPONSE");
    return { text: result.transcript, language: typeof result.language_code === "string" ? result.language_code : null,
      confidence: typeof result.language_probability === "number" && Number.isFinite(result.language_probability) ? Math.max(0, Math.min(1, result.language_probability)) : 0, final: true };
  }
  async translate(text: string, source: PipelineLanguage, target: PipelineLanguage, signal: AbortSignal): Promise<string> {
    if (!text.trim() || text.length > 2000 || source === target) throw new ProviderFailure("INVALID_TRANSLATION_INPUT");
    const result = await this.transport.request({ endpoint: "/translate", fields: { input: text, source_language_code: source, target_language_code: target, model: this.config.translationModel, mode: "formal", numerals_format: "international" } }, signal) as { translated_text?: unknown };
    if (!result || typeof result.translated_text !== "string" || !result.translated_text.trim() || result.translated_text.length > 2500) throw new ProviderFailure("INVALID_TRANSLATION_RESPONSE");
    return result.translated_text;
  }
  async synthesize(text: string, target: PipelineLanguage, signal: AbortSignal) {
    if (!text.trim() || text.length > 2500) throw new ProviderFailure("INVALID_TTS_INPUT");
    const result = await this.transport.request({ endpoint: "/text-to-speech", fields: { text, target_language_code: target, model: this.config.ttsModel, speaker: this.config.speaker, speech_sample_rate: 8000, output_audio_codec: "wav", pace: 1 } }, signal) as { audios?: unknown };
    if (!result || !Array.isArray(result.audios) || result.audios.length !== 1) throw new ProviderFailure("INVALID_TTS_RESPONSE");
    const audio = wavToPlivoMulaw(validAudioBase64(result.audios[0], 320_044));
    if (!audio.length || audio.length > 80_000) throw new ProviderFailure("TTS_AUDIO_CAPACITY_EXCEEDED");
    return { audio, encoding: "audio/x-mulaw" as const, sampleRate: 8000 as const };
  }
}

export class ScriptedSarvamMock implements SarvamProviders {
  readonly mode = "mock" as const;
  readonly calls = { stt: 0, translation: 0, tts: 0 };
  transcripts: Transcript[] = [];
  translateText = async (text: string, _source: PipelineLanguage, _target: PipelineLanguage, _signal: AbortSignal) => text;
  ttsAudio = Buffer.alloc(160, 255);
  async transcribe(_pcm: Int16Array, signal: AbortSignal): Promise<Transcript> {
    signal.throwIfAborted(); this.calls.stt++;
    return this.transcripts.shift() ?? { text: "", language: null, confidence: 0, final: true };
  }
  async translate(text: string, source: PipelineLanguage, target: PipelineLanguage, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted(); this.calls.translation++;
    return this.translateText(text, source, target, signal);
  }
  async synthesize(_text: string, _target: PipelineLanguage, signal: AbortSignal) {
    signal.throwIfAborted(); this.calls.tts++;
    return { audio: Buffer.from(this.ttsAudio), encoding: "audio/x-mulaw" as const, sampleRate: 8000 as const };
  }
}

/** Per-attempt deadline + abort propagation; only explicitly retryable failures retry, at most twice. */
export async function providerStage<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, timeoutMs: number, retries = 1): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(retries) || retries < 0 || retries > 2) throw new Error("INVALID_PROVIDER_DEADLINE");
  for (let attempt = 0; ; attempt++) {
    parent.throwIfAborted();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_, reject) => {
        abortListener = () => { controller.abort(); reject(new ProviderFailure("PROVIDER_CANCELLED")); };
        parent.addEventListener("abort", abortListener, { once: true });
        timer = setTimeout(() => { controller.abort(); reject(new ProviderFailure("PROVIDER_TIMEOUT")); }, timeoutMs);
      });
      const result = await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation(controller.signal); }), interrupted]);
      parent.throwIfAborted(); return result;
    } catch (error) {
      if (parent.aborted || !(error instanceof ProviderFailure) || !error.retryable || attempt >= retries) throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener) parent.removeEventListener("abort", abortListener);
      controller.abort();
    }
  }
}
