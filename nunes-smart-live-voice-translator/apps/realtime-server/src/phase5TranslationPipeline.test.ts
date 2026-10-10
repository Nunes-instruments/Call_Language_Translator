import { describe, it, expect, vi } from "vitest";
import {
  IndependentTranslationPipeline,
  MockPlaybackSink,
  type AudioOwner,
} from "./independentTranslationPipeline.js";
import {
  ScriptedSarvamMock,
  SarvamContractAdapters,
  ProviderFailure,
  type Transcript,
} from "./sarvamPipelineAdapters.js";
import {
  decodeMulaw,
  encodeMulaw,
  pcm16Wav,
  readPcm16Wav,
  validAudioBase64,
  wavToPlivoMulaw,
} from "./telephonyAudioCodec.js";
import { protectEntities, restoreEntities } from "@nunes/translation";

// 1600 samples (200ms of 8kHz audio) of synthetic voiced speech
const speechAudioBase64 = encodeMulaw(
  Int16Array.from({ length: 1600 }, (_, i) => Math.round(5000 * Math.sin(i * 0.2)))
).toString("base64");

const hindiTranscript: Transcript = {
  text: "mujhe Fluke 754 pressure calibrator chahiye 4-20 mA ₹12,500 GST 18%",
  language: "hi-IN",
  confidence: 0.99,
  final: true,
};

const tamilTranscript: Transcript = {
  text: "enakku GE Druck DPI 620G pressure calibrator venum 10 bar",
  language: "ta-IN",
  confidence: 0.99,
  final: true,
};

function createPhase5Fixture(timeoutMs = 150) {
  const mockProviders = new ScriptedSarvamMock();
  const pipeline = new IndependentTranslationPipeline("session-phase5", mockProviders, timeoutMs);

  const customerOwner: AudioOwner = {
    sessionId: "session-phase5",
    role: "customer",
    callUuid: "call-cust-5",
    streamId: "stream-cust-5",
    socket: { id: "socket-cust" },
  };

  const staffOwner: AudioOwner = {
    sessionId: "session-phase5",
    role: "staff",
    callUuid: "call-staff-5",
    streamId: "stream-staff-5",
    socket: { id: "socket-staff" },
  };

  pipeline.bind(customerOwner);
  pipeline.bind(staffOwner);

  const utter = async (
    owner: AudioOwner,
    transcript: Transcript,
    sequence = 1,
    audioPayload = speechAudioBase64
  ) => {
    mockProviders.transcripts.push(transcript);
    pipeline.receive(owner, sequence, audioPayload);
    pipeline.flush(owner.role);
    await pipeline.idle();
  };

  return { mockProviders, pipeline, customerOwner, staffOwner, utter };
}

describe("Phase 5: Bidirectional Language Routing & Verification", () => {
  it("translates Customer Hindi -> Staff Tamil and queues only to staff", async () => {
    const f = createPhase5Fixture();
    const translationsRecorded: string[] = [];

    f.mockProviders.translateText = async (text, source, target) => {
      translationsRecorded.push(`${source}->${target}:${text}`);
      return text;
    };

    await f.utter(f.customerOwner, hindiTranscript, 1);

    expect(f.pipeline.queued.customerToStaff).toBe(1);
    expect(f.pipeline.queued.staffToCustomer).toBe(0);
    expect(translationsRecorded).toHaveLength(1);
    expect(translationsRecorded[0]).toContain("hi-IN->ta-IN");

    const sink = new MockPlaybackSink();
    f.pipeline.drainMock("customer", sink, {
      offlineTranslationAuthorized: true,
      simulatedIsolationVerified: true,
    });

    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0].destination).toBe("staff");
    expect(sink.messages[0].event).toBe("playAudio");
    expect(sink.messages[0].media?.contentType).toBe("audio/x-mulaw");
  });

  it("translates Staff Tamil -> Customer Hindi and queues only to customer", async () => {
    const f = createPhase5Fixture();
    // Establish customer language first so staff can be routed
    await f.utter(f.customerOwner, hindiTranscript, 1);
    expect(f.pipeline.queued.customerToStaff).toBe(1);

    const translationsRecorded: string[] = [];
    f.mockProviders.translateText = async (text, source, target) => {
      translationsRecorded.push(`${source}->${target}:${text}`);
      return text;
    };

    await f.utter(f.staffOwner, tamilTranscript, 1);

    expect(f.pipeline.queued.staffToCustomer).toBe(1);
    expect(translationsRecorded).toHaveLength(1);
    expect(translationsRecorded[0]).toContain("ta-IN->hi-IN");

    const sink = new MockPlaybackSink();
    f.pipeline.drainMock("staff", sink, {
      offlineTranslationAuthorized: true,
      simulatedIsolationVerified: true,
    });

    expect(sink.messages.map((m) => m.destination)).toEqual(["customer", "customer"]);
    expect(sink.messages.map((m) => m.event)).toEqual(["clearAudio", "playAudio"]);
    expect(sink.messages[1].media?.contentType).toBe("audio/x-mulaw");
  });

  it("handles Hinglish speech with English technical terms and maps to Hindi", async () => {
    const f = createPhase5Fixture();
    const hinglishTranscript: Transcript = {
      text: "mujhe pressure calibrator chahiye jaldi quote dijiye",
      language: "en-IN", // Sarvam often detects code-mixed Hinglish as en-IN
      confidence: 0.92,
      final: true,
    };

    await f.utter(f.customerOwner, hinglishTranscript, 1);

    expect(f.mockProviders.calls.translation).toBe(1);
    expect(f.pipeline.queued.customerToStaff).toBe(1);
  });

  it("handles Tanglish speech with English technical terms and maps to Tamil", async () => {
    const f = createPhase5Fixture();
    await f.utter(f.customerOwner, hindiTranscript, 1);

    const tanglishTranscript: Transcript = {
      text: "enakku pressure calibrator venum konjam rate sollunga",
      language: "en-IN", // Sarvam often detects code-mixed Tanglish as en-IN
      confidence: 0.91,
      final: true,
    };

    await f.utter(f.staffOwner, tanglishTranscript, 1);

    expect(f.mockProviders.calls.translation).toBe(2);
    expect(f.pipeline.queued.staffToCustomer).toBe(1);
  });

  it("preserves technical model numbers, units, currency and GST across translation", async () => {
    const f = createPhase5Fixture();
    let translatedPayload = "";

    f.mockProviders.translateText = async (text) => {
      translatedPayload = text;
      return text; // Return text with intact entity tokens
    };

    const technicalTranscript: Transcript = {
      text: "Fluke 754 DPI 620G 4-20 mA 100 psi ₹25,000 GST 18%",
      language: "hi-IN",
      confidence: 0.99,
      final: true,
    };

    await f.utter(f.customerOwner, technicalTranscript, 1);

    // Tokens were injected for the translation call
    expect(translatedPayload).toMatch(/NUNESENTITY/);
    expect(f.mockProviders.calls.tts).toBe(1);
    expect(f.pipeline.queued.customerToStaff).toBe(1);
  });

  it("holds unknown languages without translating or generating TTS", async () => {
    const f = createPhase5Fixture();
    const unknownTranscript: Transcript = {
      text: "bonjour comment ca va",
      language: "fr-FR",
      confidence: 0.95,
      final: true,
    };

    await f.utter(f.customerOwner, unknownTranscript, 1);

    expect(f.mockProviders.calls.translation).toBe(0);
    expect(f.mockProviders.calls.tts).toBe(0);
    expect(f.pipeline.metrics.held).toBe(1);
    expect(f.pipeline.queued.customerToStaff).toBe(0);
  });

  it("holds low-confidence STT results (< 0.72)", async () => {
    const f = createPhase5Fixture();
    const lowConfidenceTranscript: Transcript = {
      text: "mujhe calibrator chahiye",
      language: "hi-IN",
      confidence: 0.65, // Below hold threshold (0.72)
      final: true,
    };

    await f.utter(f.customerOwner, lowConfidenceTranscript, 1);

    expect(f.mockProviders.calls.translation).toBe(0);
    expect(f.pipeline.metrics.held).toBe(1);
    expect(f.pipeline.queued.customerToStaff).toBe(0);
  });

  it("holds empty or whitespace-only STT results", async () => {
    const f = createPhase5Fixture();
    const emptyTranscript: Transcript = {
      text: "   \t\n  ",
      language: "hi-IN",
      confidence: 0.95,
      final: true,
    };

    await f.utter(f.customerOwner, emptyTranscript, 1);

    expect(f.mockProviders.calls.translation).toBe(0);
    expect(f.pipeline.metrics.held).toBe(1);
  });

  it("holds interim / non-final transcripts without triggering translation", async () => {
    const f = createPhase5Fixture();
    const interimTranscript: Transcript = {
      text: "mujhe Fluke",
      language: "hi-IN",
      confidence: 0.95,
      final: false, // Interim
    };

    await f.utter(f.customerOwner, interimTranscript, 1);

    expect(f.mockProviders.calls.translation).toBe(0);
    expect(f.pipeline.metrics.held).toBe(1);
  });

  it("enforces strict monotonic sequence order and rejects duplicates/regressions", () => {
    const f = createPhase5Fixture();
    f.pipeline.receive(f.customerOwner, 10, speechAudioBase64);

    expect(() => f.pipeline.receive(f.customerOwner, 10, speechAudioBase64)).toThrow("SEQUENCE");
    expect(() => f.pipeline.receive(f.customerOwner, 9, speechAudioBase64)).toThrow("SEQUENCE");
    expect(() => f.pipeline.receive(f.customerOwner, 0, speechAudioBase64)).toThrow("SEQUENCE");
    expect(() => f.pipeline.receive(f.customerOwner, NaN, speechAudioBase64)).toThrow("SEQUENCE");
  });

  it("blocks Tamil-to-Tamil original audio bypass and records ORIGINAL_AUDIO_PATH_UNVERIFIED", async () => {
    const f = createPhase5Fixture();
    // Customer speaks Tamil when staff is already Tamil -> router selects DIRECT_BYPASS
    await f.utter(f.customerOwner, tamilTranscript, 1);

    expect(f.pipeline.metrics.lastError).toBe("ORIGINAL_AUDIO_PATH_UNVERIFIED");
    expect(f.mockProviders.calls.tts).toBe(0);
    expect(f.pipeline.queued.customerToStaff).toBe(0);
  });
});

describe("Phase 5: Audio Isolation, Ownership & Playback Safety", () => {
  it("enforces strict leg ownership and rejects mismatched owner metadata", () => {
    const f = createPhase5Fixture();

    expect(() =>
      f.pipeline.receive({ ...f.customerOwner, sessionId: "other-session" }, 1, speechAudioBase64)
    ).toThrow("IDENTITY");

    expect(() =>
      f.pipeline.receive({ ...f.customerOwner, callUuid: "other-call" }, 1, speechAudioBase64)
    ).toThrow("IDENTITY");

    expect(() =>
      f.pipeline.receive({ ...f.customerOwner, streamId: "other-stream" }, 1, speechAudioBase64)
    ).toThrow("IDENTITY");

    expect(() =>
      f.pipeline.receive({ ...f.customerOwner, socket: {} }, 1, speechAudioBase64)
    ).toThrow("IDENTITY");
  });

  it("rejects binding the same socket across multiple roles (cross-leg hijacking)", () => {
    const f = createPhase5Fixture();
    const duplicateSocketOwner: AudioOwner = {
      sessionId: "session-phase5",
      role: "staff",
      callUuid: "call-hijack",
      streamId: "stream-hijack",
      socket: f.customerOwner.socket, // Attacker tries to share customer socket
    };

    expect(() => f.pipeline.bind(duplicateSocketOwner)).toThrow("SOCKET_ALREADY_OWNED");
  });

  it("fails closed on production playback attempt: AUDIO_ISOLATION_UNVERIFIED", () => {
    const f = createPhase5Fixture();
    expect(() => f.pipeline.productionPlayback()).toThrow("AUDIO_ISOLATION_UNVERIFIED");
    expect(f.pipeline.gates.actualAudioIsolationVerified).toBe(false);
    expect(f.pipeline.gates.productionTranslationAuthorized).toBe(false);
  });

  it("rejects mock drainage if unauthorized or unverified", async () => {
    const f = createPhase5Fixture();
    await f.utter(f.customerOwner, hindiTranscript, 1);
    const sink = new MockPlaybackSink();

    expect(() =>
      f.pipeline.drainMock("customer", sink, {
        offlineTranslationAuthorized: false,
        simulatedIsolationVerified: true,
      })
    ).toThrow("OFFLINE_PLAYBACK_GATE_CLOSED");

    expect(() =>
      f.pipeline.drainMock("customer", sink, {
        offlineTranslationAuthorized: true,
        simulatedIsolationVerified: false,
      })
    ).toThrow("OFFLINE_PLAYBACK_GATE_CLOSED");
  });

  it("prevents closed sessions from receiving or draining audio", async () => {
    const f = createPhase5Fixture();
    await f.utter(f.customerOwner, hindiTranscript, 1);

    f.pipeline.close();

    const sink = new MockPlaybackSink();
    expect(() =>
      f.pipeline.drainMock("customer", sink, {
        offlineTranslationAuthorized: true,
        simulatedIsolationVerified: true,
      })
    ).toThrow("SESSION_CLOSED");

    expect(() => f.pipeline.receive(f.customerOwner, 2, speechAudioBase64)).toThrow(
      "INVALID_AUDIO_IDENTITY_OR_SEQUENCE"
    );
  });

  it("drops delayed TTS response after session cancellation or invalidation", async () => {
    const f = createPhase5Fixture();
    let resolveTts!: (value: Awaited<ReturnType<typeof f.mockProviders.synthesize>>) => void;

    f.mockProviders.synthesize = () =>
      new Promise((done) => {
        resolveTts = done;
      });

    // Send utterance
    f.mockProviders.transcripts.push(hindiTranscript);
    f.pipeline.receive(f.customerOwner, 1, speechAudioBase64);
    f.pipeline.flush("customer");

    // Give time for STT and translation to complete and reach TTS stage
    await new Promise((done) => setImmediate(done));

    // Cancel / close the pipeline before TTS resolves
    f.pipeline.close();

    // Now late TTS arrives
    resolveTts({
      audio: Buffer.alloc(160, 255),
      encoding: "audio/x-mulaw",
      sampleRate: 8000,
    });

    await f.pipeline.idle();

    // The delayed audio must NOT be queued
    expect(f.pipeline.queued.customerToStaff).toBe(0);
  });

  it("executes barge-in: clears opposite leg pending work and queues clearAudio event", async () => {
    const f = createPhase5Fixture();
    // Customer has prepared audio
    await f.utter(f.customerOwner, hindiTranscript, 1);
    expect(f.pipeline.queued.customerToStaff).toBe(1);

    // Staff interrupts (speaks)
    f.pipeline.receive(f.staffOwner, 1, speechAudioBase64);

    // Queue of customer-to-staff work was purged
    expect(f.pipeline.queued.customerToStaff).toBe(0);

    const sink = new MockPlaybackSink();
    f.pipeline.drainMock("staff", sink, {
      offlineTranslationAuthorized: true,
      simulatedIsolationVerified: true,
    });

    const clearMsg = sink.messages.find((m) => m.event === "clearAudio");
    expect(clearMsg).toBeDefined();
    expect(clearMsg?.destination).toBe("customer");
  });

  it("fails closed on TTS failure without leaking original audio", async () => {
    const f = createPhase5Fixture();
    f.mockProviders.synthesize = async () => {
      throw new Error("Internal TTS engine failure");
    };

    await f.utter(f.customerOwner, hindiTranscript, 1);

    expect(f.pipeline.metrics.lastError).toBe("PROVIDER_FAILURE");
    expect(f.pipeline.queued.customerToStaff).toBe(0);
    // Never leaks raw speech
    const sink = new MockPlaybackSink();
    f.pipeline.drainMock("customer", sink, {
      offlineTranslationAuthorized: true,
      simulatedIsolationVerified: true,
    });
    expect(sink.messages).toHaveLength(0);
  });
});

describe("Phase 5: Realtime Performance, Bounded Queues & Stability", () => {
  it("bounds queued audio and triggers clean invalidation on overflow", async () => {
    const f = createPhase5Fixture();
    for (let seq = 1; seq <= 5; seq++) {
      await f.utter(f.customerOwner, hindiTranscript, seq);
    }

    expect(f.pipeline.metrics.overflow).toBeGreaterThanOrEqual(1);
    expect(f.pipeline.queued.customerToStaff).toBe(0);
  });

  it("bounds pending async operations to prevent memory leaks", async () => {
    const f = createPhase5Fixture(5);
    // Hanging transcription
    f.mockProviders.transcribe = () => new Promise(() => {});

    for (let seq = 1; seq <= 5; seq++) {
      f.pipeline.receive(f.customerOwner, seq, speechAudioBase64);
      f.pipeline.flush("customer");
    }

    await f.pipeline.idle();
    expect(f.pipeline.metrics.overflow).toBeGreaterThanOrEqual(1);
  });

  it("recovers cleanly from dropped WebSockets and re-binding new socket", async () => {
    const f = createPhase5Fixture();
    await f.utter(f.customerOwner, hindiTranscript, 1);

    // Customer disconnects
    f.pipeline.disconnect("customer");
    expect(f.pipeline.queued.customerToStaff).toBe(0);

    // Re-bind with new socket
    const newCustomerOwner: AudioOwner = {
      ...f.customerOwner,
      streamId: "stream-cust-reconnect",
      socket: { id: "new-socket" },
    };
    f.pipeline.bind(newCustomerOwner);

    // Customer can now speak again cleanly
    await f.utter(newCustomerOwner, hindiTranscript, 1);
    expect(f.pipeline.queued.customerToStaff).toBe(1);
  });

  it("times out unresponsive provider within configured deadline", async () => {
    const f = createPhase5Fixture(10); // 10ms timeout
    f.mockProviders.transcribe = () => new Promise(() => {}); // never resolves

    await f.utter(f.customerOwner, hindiTranscript, 1);

    expect(f.pipeline.metrics.lastError).toBe("PROVIDER_TIMEOUT");
    expect(f.pipeline.queued.customerToStaff).toBe(0);
  });
});
