import { describe, it, expect, vi } from "vitest";
import { IndependentTranslationPipeline, MockPlaybackSink, type AudioOwner } from "./independentTranslationPipeline.js";
import { ScriptedSarvamMock, SarvamContractAdapters, ProviderFailure, providerStage, type Transcript } from "./sarvamPipelineAdapters.js";
import { decodeMulaw, encodeMulaw, pcm16Wav, readPcm16Wav, validAudioBase64, wavToPlivoMulaw } from "./telephonyAudioCodec.js";
import { protectEntities, restoreEntities } from "@nunes/translation";
const speech = encodeMulaw(Int16Array.from({ length: 1600 }, (_, i) => Math.round(5000 * Math.sin(i * .2)))).toString("base64");
const hi: Transcript = { text: "mujhe Fluke 754 chahiye 4-20 mA ₹12,500 GST 18%", language: "hi-IN", confidence: .99, final: true };
const ta: Transcript = { text: "enakku pressure calibrator venum 2 10 bar", language: "ta-IN", confidence: .99, final: true };
function fixture(timeout = 100) {
  const mock = new ScriptedSarvamMock(), pipeline = new IndependentTranslationPipeline("s1", mock, timeout);
  const customer: AudioOwner = { sessionId: "s1", role: "customer", callUuid: "c1", streamId: "cs1", socket: {} };
  const staff: AudioOwner = { sessionId: "s1", role: "staff", callUuid: "c2", streamId: "ss1", socket: {} };
  pipeline.bind(customer); pipeline.bind(staff);
  const utter = async (owner: AudioOwner, transcript: Transcript, sequence = 1) => { mock.transcripts.push(transcript); pipeline.receive(owner, sequence, speech); pipeline.flush(owner.role); await pipeline.idle(); };
  return { mock, pipeline, customer, staff, utter };
}
describe("Phase 3 authenticated offline pipeline", () => {
  it("prepares both directions and preserves entities without network or socket sends", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("NETWORK_FORBIDDEN"));
    try {
      const f = fixture(); const translated: string[] = [];
      f.mock.translateText = async (text, source, target) => { translated.push(`${source}:${target}:${text}`); return text; };
      await f.utter(f.customer, hi); const sink = new MockPlaybackSink();
      f.pipeline.drainMock("customer", sink, { offlineTranslationAuthorized: true, simulatedIsolationVerified: true });
      await f.utter(f.staff, ta);
      f.pipeline.drainMock("staff", sink, { offlineTranslationAuthorized: true, simulatedIsolationVerified: true });
      expect(sink.messages.filter(message => message.event === "playAudio").map(message => message.destination)).toEqual(["staff", "customer"]);
      expect(translated[0]).toContain("hi-IN:ta-IN"); expect(translated[1]).toContain("ta-IN:hi-IN");
      expect(translated[0]).not.toContain("12,500"); expect(f.mock.calls).toEqual({ stt: 2, translation: 2, tts: 2 }); expect(fetch).not.toHaveBeenCalled();
      expect(f.pipeline.gates.actualAudioIsolationVerified).toBe(false); expect(f.pipeline.gates.productionTranslationAuthorized).toBe(false);
    } finally { fetch.mockRestore(); }
  });
  it.each(["sessionId", "callUuid", "streamId", "socket"] as const)("rejects wrong %s", field => {
    const f = fixture(); expect(() => f.pipeline.receive({ ...f.customer, [field]: field === "socket" ? {} : "other" }, 1, speech)).toThrow("IDENTITY"); expect(f.mock.calls.stt).toBe(0);
  });
  it("rejects duplicate and out-of-order frames", () => { const f = fixture(); f.pipeline.receive(f.customer, 2, speech); for (const sequence of [2, 1, NaN, Infinity]) expect(() => f.pipeline.receive(f.customer, sequence, speech)).toThrow("SEQUENCE"); });
  it("rejects a customer packet claiming the staff role", () => { const f = fixture(); expect(() => f.pipeline.receive({ ...f.customer, role: "staff" }, 1, speech)).toThrow("IDENTITY"); });
  it("routes Hinglish and Tanglish with neutral English technical terms", async () => { const f = fixture(); await f.utter(f.customer, { ...hi, language: "en-IN", text: "mujhe pressure calibrator chahiye jaldi" }); await f.utter(f.staff, { ...ta, language: "en-IN", text: "enakku pressure calibrator venum konjam" }); expect(f.mock.calls.translation).toBe(2); });
  it("holds conflicting staff language", async () => { const f = fixture(); await f.utter(f.customer, hi); await f.utter(f.staff, hi); expect(f.mock.calls.translation).toBe(1); });
  it.each([{ ...hi, language: null, text: "technical details", confidence: 0 }, { ...hi, confidence: .2 }, { ...hi, final: false }])("holds uncertain or partial transcripts", async transcript => { const f = fixture(); await f.utter(f.customer, transcript); expect(f.mock.calls.translation).toBe(0); expect(f.pipeline.metrics.held).toBe(1); });
  it("does not apply an old Hindi decision to current unknown speech", async () => { const f = fixture(); await f.utter(f.customer, hi); await f.utter(f.customer, { text: "okay", language: null, confidence: 0, final: true }, 2); expect(f.mock.calls.translation).toBe(1); });
  it("holds staff until customer language is established", async () => { const f = fixture(); await f.utter(f.staff, ta); expect(f.mock.calls.translation).toBe(0); });
  it("blocks unverified Tamil/Tamil original path", async () => { const f = fixture(); await f.utter(f.customer, ta); expect(f.pipeline.metrics.lastError).toBe("ORIGINAL_AUDIO_PATH_UNVERIFIED"); expect(f.mock.calls.tts).toBe(0); });
  it.each(["Fluke 754", "GE Druck 620", "4-20 mA", "₹12,500", "18%", "2", "10 bar"])("protects %s", entity => { expect(protectEntities(`mujhe ${entity} chahiye`).entities.map(item => item.original).join(" ")).toContain(entity); });
  it("restores two-digit tokens and currency without prefix corruption", () => { const input = "Fluke GST ISO Druck WhatsApp 1 2 3 4 5 $120 USD 250"; const protectedText = protectEntities(input); expect(protectedText.entities.length).toBeGreaterThan(9); expect(restoreEntities(protectedText.text, protectedText.entities)).toBe(input); });
  it.each(["missing", "duplicate", "collision"])("fails closed on %s entity tokens", async kind => {
    const f = fixture(); f.mock.translateText = async text => kind === "duplicate" ? `${text} ${text}` : "changed";
    await f.utter(f.customer, kind === "collision" ? { ...hi, text: "mujhe NUNESENTITY1 chahiye" } : hi);
    expect(f.mock.calls.tts).toBe(0); expect(f.pipeline.metrics.lastError).toMatch(/ENTITY/);
  });
  it("flushes prepared audio and rejects stale owner on reconnect", async () => { const f = fixture(); await f.utter(f.customer, hi); f.pipeline.disconnect("customer"); const next = { ...f.customer, streamId: "new", socket: {} }; f.pipeline.bind(next); expect(f.pipeline.queued.customerToStaff).toBe(0); expect(() => f.pipeline.receive(f.customer, 2, speech)).toThrow(); });
  it("cancels late STT after hangup", async () => { const f = fixture(); let resolve!: (value: Transcript) => void; f.mock.transcribe = () => new Promise(done => { resolve = done; }); f.pipeline.receive(f.customer, 1, speech); f.pipeline.flush("customer"); await new Promise(done => setTimeout(done, 0)); f.pipeline.close(); resolve(hi); await f.pipeline.idle(); expect(f.mock.calls.translation).toBe(0); expect(f.pipeline.queued.customerToStaff).toBe(0); });
  it("times out an unresponsive provider", async () => { const f = fixture(5); f.mock.transcribe = () => new Promise(() => {}); await f.utter(f.customer, hi); expect(f.pipeline.metrics.lastError).toBe("PROVIDER_TIMEOUT"); });
  it("handles TTS failures without queued audio", async () => { const f = fixture(); f.mock.synthesize = async () => { throw new Error("sensitive provider error"); }; await f.utter(f.customer, hi); expect(f.pipeline.metrics.lastError).toBe("PROVIDER_FAILURE"); expect(f.pipeline.queued.customerToStaff).toBe(0); });
  it("barge-in clears pending audio to the speaking leg", async () => { const f = fixture(); await f.utter(f.customer, hi); f.pipeline.receive(f.staff, 1, speech); expect(f.pipeline.queued.customerToStaff).toBe(0); });
  it("bounds prepared queue and flushes on overflow", async () => { const f = fixture(); for (let sequence = 1; sequence <= 5; sequence++) await f.utter(f.customer, hi, sequence); expect(f.pipeline.metrics.overflow).toBe(1); expect(f.pipeline.queued.customerToStaff).toBe(0); });
  it("retains ordered utterances", async () => { const f = fixture(); for (let sequence = 1; sequence <= 3; sequence++) { f.mock.transcripts.push(hi); f.pipeline.receive(f.customer, sequence, speech); f.pipeline.flush("customer"); } await f.pipeline.idle(); expect(f.pipeline.queued.customerToStaff).toBe(3); });
  it("bounds pending jobs", async () => { const f = fixture(5); f.mock.transcribe = () => new Promise(() => {}); for (let sequence = 1; sequence <= 5; sequence++) { f.pipeline.receive(f.customer, sequence, speech); f.pipeline.flush("customer"); } await f.pipeline.idle(); expect(f.pipeline.metrics.overflow).toBe(1); });
  it("segments speech followed by silence and ignores pure silence", async () => { const f = fixture(); f.pipeline.receive(f.customer, 1, Buffer.alloc(2400, 255).toString("base64")); expect(f.mock.calls.stt).toBe(0); f.mock.transcripts.push(hi); f.pipeline.receive(f.customer, 2, speech); f.pipeline.receive(f.customer, 3, Buffer.alloc(2400, 255).toString("base64")); await f.pipeline.idle(); expect(f.mock.calls.stt).toBe(1); });
  it("suppresses exact simulated playback echo", async () => { const f = fixture(); f.mock.ttsAudio = Buffer.from(speech, "base64"); await f.utter(f.customer, hi); f.pipeline.drainMock("customer", new MockPlaybackSink(), { offlineTranslationAuthorized: true, simulatedIsolationVerified: true }); f.pipeline.receive(f.staff, 1, speech); expect(f.pipeline.metrics.echoSuppressed).toBe(1); });
  it("keeps production and mock playback gates separate", async () => { const f = fixture(); await f.utter(f.customer, hi); expect(() => f.pipeline.productionPlayback()).toThrow("ISOLATION"); for (const authorization of [{ offlineTranslationAuthorized: false, simulatedIsolationVerified: true }, { offlineTranslationAuthorized: true, simulatedIsolationVerified: false }]) expect(() => f.pipeline.drainMock("customer", new MockPlaybackSink(), authorization)).toThrow("GATE"); expect(f.pipeline.queued.customerToStaff).toBe(1); });
  it("rejects live provider injection", () => { const mock = new ScriptedSarvamMock(); expect(() => new IndependentTranslationPipeline("s", { ...mock, mode: "live" } as unknown as ScriptedSarvamMock)).toThrow("BILLABLE"); });
});
describe("Phase 3 codecs and provider contracts", () => {
  it("decodes standard mu-law vectors", () => { expect([...decodeMulaw(Buffer.from([255, 127, 0, 128]))]).toEqual([0, 0, -32124, 32124]); });
  it.each([8000, 16000, 24000])("validates WAV and prepares 8k mu-law from %i Hz", rate => { const pcm = Int16Array.from({ length: rate / 10 }, () => 1000); const wav = pcm16Wav(pcm, rate); expect(readPcm16Wav(wav).sampleRate).toBe(rate); expect(wavToPlivoMulaw(wav).length).toBe(800); });
  it.each(["", "!!!!", "Zg=", "Zh=="])("rejects invalid base64 %s", payload => { expect(() => validAudioBase64(payload)).toThrow(); });
  it("rejects incompatible WAV", () => { const wav = pcm16Wav(new Int16Array(160)); wav.writeUInt16LE(2, 22); expect(() => wavToPlivoMulaw(wav)).toThrow("FORMAT"); expect(() => readPcm16Wav(Buffer.alloc(44))).toThrow(); });
  it("builds documented mock requests and validates responses", async () => {
    const requests: unknown[] = []; const adapters = new SarvamContractAdapters({ mode: "mock", request: async request => { requests.push(request); return request.endpoint === "/speech-to-text" ? { transcript: hi.text, language_code: "hi-IN", language_probability: .99 } : request.endpoint === "/translate" ? { translated_text: "தமிழ்" } : { audios: [pcm16Wav(new Int16Array(160)).toString("base64")] }; } });
    const signal = new AbortController().signal; expect((await adapters.transcribe(new Int16Array(160), signal)).final).toBe(true); await adapters.translate("hello", "hi-IN", "ta-IN", signal); expect((await adapters.synthesize("தமிழ்", "ta-IN", signal)).audio.length).toBe(160);
    expect(requests).toMatchObject([{ fields: { model: "saaras:v4", language_code: "unknown", mode: "codemix" }, file: { contentType: "audio/wav" } }, { fields: { model: "sarvam-translate:v1", source_language_code: "hi-IN", target_language_code: "ta-IN" } }, { fields: { model: "bulbul:v3", output_audio_codec: "wav", speech_sample_rate: 8000 } }]);
  });
  it("rejects live transport", () => { expect(() => new SarvamContractAdapters({ mode: "live", request: async () => ({}) })).toThrow("BILLABLE"); });
  it.each(["stt", "translation", "tts"])("rejects invalid %s responses", async stage => { const adapters = new SarvamContractAdapters({ mode: "mock", request: async () => ({}) }); const signal = new AbortController().signal; const operation = stage === "stt" ? adapters.transcribe(new Int16Array(160), signal) : stage === "translation" ? adapters.translate("hello", "hi-IN", "ta-IN", signal) : adapters.synthesize("hello", "ta-IN", signal); await expect(operation).rejects.toThrow("INVALID_"); });
  it("retries only bounded explicit transient failures", async () => { let calls = 0; const result = await providerStage(async () => { if (++calls < 2) throw new ProviderFailure("TRANSIENT", true); return 7; }, new AbortController().signal, 20); expect(result).toBe(7); expect(calls).toBe(2); });
  it("does not retry timeout or nonretryable error", async () => { let calls = 0; await expect(providerStage(async () => { calls++; throw new ProviderFailure("BAD"); }, new AbortController().signal, 20)).rejects.toThrow("BAD"); expect(calls).toBe(1); });
  it("propagates cancellation and ignores late results", async () => { const controller = new AbortController(); const result = providerStage(() => new Promise(() => {}), controller.signal, 100); controller.abort(); await expect(result).rejects.toThrow("CANCELLED"); });
});
