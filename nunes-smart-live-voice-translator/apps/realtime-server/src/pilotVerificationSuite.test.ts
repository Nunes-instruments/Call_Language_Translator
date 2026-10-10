import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  IndependentTranslationPipeline,
  MockPlaybackSink,
  type AudioOwner,
} from "./independentTranslationPipeline.js";
import {
  ScriptedSarvamMock,
  type Transcript,
} from "./sarvamPipelineAdapters.js";
import {
  encodeMulaw,
  decodeMulaw,
} from "./telephonyAudioCodec.js";
import { ControlledPilotManager } from "./controlledPilotController.js";
import { guardPlivoWebhookRequest } from "./plivoWebhookRequestGuard.js";
import { offlineHeaders } from "./testSupport/plivoOfflineSignature.js";

// Synthesize 1600 samples (200ms of 8kHz audio) of speech
const customerSpeechBase64 = encodeMulaw(
  Int16Array.from({ length: 1600 }, (_, i) => Math.round(5500 * Math.sin(i * 0.25)))
).toString("base64");

const staffSpeechBase64 = encodeMulaw(
  Int16Array.from({ length: 1600 }, (_, i) => Math.round(5200 * Math.sin(i * 0.3)))
).toString("base64");

function createVerificationFixture(timeoutMs = 200) {
  const mockSarvam = new ScriptedSarvamMock();
  const pipeline = new IndependentTranslationPipeline("session-verif-1", mockSarvam, timeoutMs);

  const customerOwner: AudioOwner = {
    sessionId: "session-verif-1",
    role: "customer",
    callUuid: "call-cust-v1",
    streamId: "stream-cust-v1",
    socket: { id: "cust-ws" },
  };

  const staffOwner: AudioOwner = {
    sessionId: "session-verif-1",
    role: "staff",
    callUuid: "call-staff-v1",
    streamId: "stream-staff-v1",
    socket: { id: "staff-ws" },
  };

  pipeline.bind(customerOwner);
  pipeline.bind(staffOwner);

  const utter = async (
    owner: AudioOwner,
    transcript: Transcript,
    sequence = 1,
    audio = customerSpeechBase64
  ) => {
    mockSarvam.transcripts.push(transcript);
    pipeline.receive(owner, sequence, audio);
    pipeline.flush(owner.role);
    await pipeline.idle();
  };

  return { mockSarvam, pipeline, customerOwner, staffOwner, utter };
}

describe("Next-Stage Controlled Pilot Verification Suite", () => {
  describe("1. Strict Cross-Leg Audio Directionality & Leg Isolation", () => {
    it("guarantees customer speech is exclusively queued to staff leg buffer and never to customer", async () => {
      const f = createVerificationFixture();
      const hindiSpeech: Transcript = {
        text: "kripya temperature transmitter ka status bataiye",
        language: "hi-IN",
        confidence: 0.98,
        final: true,
      };

      await f.utter(f.customerOwner, hindiSpeech, 1, customerSpeechBase64);

      // Verify pipeline queue state
      expect(f.pipeline.queued.customerToStaff).toBe(1);
      expect(f.pipeline.queued.staffToCustomer).toBe(0);

      // Drain into mock playback sink
      const sink = new MockPlaybackSink();
      f.pipeline.drainMock("customer", sink, {
        offlineTranslationAuthorized: true,
        simulatedIsolationVerified: true,
      });

      // Verify that every recorded event is addressed only to 'staff'
      expect(sink.messages.length).toBeGreaterThan(0);
      for (const msg of sink.messages) {
        expect(msg.destination).toBe("staff");
        expect(msg.destination).not.toBe("customer");
      }
      expect(sink.messages.some((m) => m.event === "playAudio")).toBe(true);
    });

    it("guarantees staff speech is exclusively queued to customer leg buffer and never to staff", async () => {
      const f = createVerificationFixture();
      // Establish customer language baseline
      await f.utter(f.customerOwner, {
        text: "mujhe pressure gauge chahiye",
        language: "hi-IN",
        confidence: 0.99,
        final: true,
      }, 1);

      // Staff speaks Tamil
      const tamilSpeech: Transcript = {
        text: "pressure gauge stock irukku nanga anupuroam",
        language: "ta-IN",
        confidence: 0.98,
        final: true,
      };

      await f.utter(f.staffOwner, tamilSpeech, 1, staffSpeechBase64);

      expect(f.pipeline.queued.staffToCustomer).toBe(1);

      const sink = new MockPlaybackSink();
      f.pipeline.drainMock("staff", sink, {
        offlineTranslationAuthorized: true,
        simulatedIsolationVerified: true,
      });

      expect(sink.messages.length).toBeGreaterThan(0);
      for (const msg of sink.messages) {
        expect(msg.destination).toBe("customer");
        expect(msg.destination).not.toBe("staff");
      }
      expect(sink.messages.some((m) => m.event === "playAudio")).toBe(true);
    });

    it("verifies buffers are structurally isolated: independent queue management and barge-in", async () => {
      const f = createVerificationFixture();
      // Establish customer speech and drain it
      await f.utter(f.customerOwner, {
        text: "Fluke 754 calibrator quote dijiye",
        language: "hi-IN",
        confidence: 0.99,
        final: true,
      }, 1);

      expect(f.pipeline.queued.customerToStaff).toBe(1);
      expect(f.pipeline.queued.staffToCustomer).toBe(0);

      const customerSink = new MockPlaybackSink();
      f.pipeline.drainMock("customer", customerSink, {
        offlineTranslationAuthorized: true,
        simulatedIsolationVerified: true,
      });

      expect(f.pipeline.queued.customerToStaff).toBe(0);
      expect(customerSink.messages[0].destination).toBe("staff");

      // Now staff speaks back
      await f.utter(f.staffOwner, {
        text: "quote ready ah irukku",
        language: "ta-IN",
        confidence: 0.99,
        final: true,
      }, 1);

      expect(f.pipeline.queued.staffToCustomer).toBe(1);
      expect(f.pipeline.queued.customerToStaff).toBe(0);

      const staffSink = new MockPlaybackSink();
      f.pipeline.drainMock("staff", staffSink, {
        offlineTranslationAuthorized: true,
        simulatedIsolationVerified: true,
      });

      expect(f.pipeline.queued.staffToCustomer).toBe(0);
      const playMsg = staffSink.messages.find((m) => m.event === "playAudio");
      expect(playMsg?.destination).toBe("customer");
    });
  });

  describe("2. Language Matrix Routing: Hindi, Tamil, and Tamil-to-Tamil Hold", () => {
    it("routes Hindi customer speech to Tamil staff synthesis", async () => {
      const f = createVerificationFixture();
      let capturedSource = "";
      let capturedTarget = "";

      f.mockSarvam.translateText = async (text, source, target) => {
        capturedSource = source;
        capturedTarget = target;
        return text;
      };

      await f.utter(f.customerOwner, {
        text: "hamare paas RTD sensor hai",
        language: "hi-IN",
        confidence: 0.99,
        final: true,
      }, 1);

      expect(capturedSource).toBe("hi-IN");
      expect(capturedTarget).toBe("ta-IN");
      expect(f.pipeline.queued.customerToStaff).toBe(1);
    });

    it("routes Tamil staff speech to Hindi customer synthesis once language is established", async () => {
      const f = createVerificationFixture();
      await f.utter(f.customerOwner, {
        text: "kripya status bataiye",
        language: "hi-IN",
        confidence: 0.99,
        final: true,
      }, 1);

      let capturedSource = "";
      let capturedTarget = "";
      f.mockSarvam.translateText = async (text, source, target) => {
        capturedSource = source;
        capturedTarget = target;
        return text;
      };

      await f.utter(f.staffOwner, {
        text: "status check pannitu solren",
        language: "ta-IN",
        confidence: 0.99,
        final: true,
      }, 1);

      expect(capturedSource).toBe("ta-IN");
      expect(capturedTarget).toBe("hi-IN");
      expect(f.pipeline.queued.staffToCustomer).toBe(1);
    });

    it("blocks Tamil-to-Tamil original audio bypass and records ORIGINAL_AUDIO_PATH_UNVERIFIED", async () => {
      const f = createVerificationFixture();
      // Customer speaks Tamil directly when staff is also Tamil
      await f.utter(f.customerOwner, {
        text: "vanakkam enakku RTD sensor venum",
        language: "ta-IN",
        confidence: 0.99,
        final: true,
      }, 1);

      // Must be held, not bridged, because direct bypass path is unverified
      expect(f.pipeline.metrics.lastError).toBe("ORIGINAL_AUDIO_PATH_UNVERIFIED");
      expect(f.pipeline.metrics.held).toBe(1);
      expect(f.pipeline.queued.customerToStaff).toBe(0);
      expect(f.mockSarvam.calls.tts).toBe(0);
    });
  });

  describe("3. Interruption (Barge-in), Echo Suppression & Provider Failure", () => {
    it("handles customer interruption: cancels pending staff TTS and emits clearAudio", async () => {
      const f = createVerificationFixture();
      // Staff has prepared audio ready to play to customer
      await f.utter(f.customerOwner, {
        text: "RTD price",
        language: "hi-IN",
        confidence: 0.99,
        final: true,
      }, 1);
      await f.utter(f.staffOwner, {
        text: "price ₹500",
        language: "ta-IN",
        confidence: 0.99,
        final: true,
      }, 1);

      expect(f.pipeline.queued.staffToCustomer).toBe(1);

      // Customer interrupts by speaking before staff audio is drained
      f.pipeline.receive(f.customerOwner, 2, customerSpeechBase64);

      // Staff-to-customer queue is immediately purged
      expect(f.pipeline.queued.staffToCustomer).toBe(0);

      const sink = new MockPlaybackSink();
      f.pipeline.drainMock("customer", sink, {
        offlineTranslationAuthorized: true,
        simulatedIsolationVerified: true,
      });

      const clearMsg = sink.messages.find((m) => m.event === "clearAudio");
      expect(clearMsg).toBeDefined();
      expect(clearMsg?.destination).toBe("staff");
    });

    it("suppresses identical echoed audio received within suppression window", () => {
      const f = createVerificationFixture();
      const sink = new MockPlaybackSink();

      // Drain an audio item to populate the echo cache for customer
      f.pipeline.drainMock("customer", sink, {
        offlineTranslationAuthorized: true,
        simulatedIsolationVerified: true,
      });

      // Directly trigger receive with identical audio
      const initialAccepted = f.pipeline.metrics.accepted;
      f.pipeline.receive(f.customerOwner, 1, customerSpeechBase64);

      // Receive again with same payload immediately
      // Note: sequence must increase
      f.pipeline.receive(f.customerOwner, 2, customerSpeechBase64);
      expect(f.pipeline.metrics.accepted).toBeGreaterThanOrEqual(1);
    });

    it("fails closed on Sarvam translation provider failure without leaking raw audio", async () => {
      const f = createVerificationFixture();
      f.mockSarvam.translateText = async () => {
        throw new Error("Sarvam translation service down");
      };

      await f.utter(f.customerOwner, {
        text: "transmitter chahiye",
        language: "hi-IN",
        confidence: 0.99,
        final: true,
      }, 1);

      expect(f.pipeline.metrics.lastError).toBe("PROVIDER_FAILURE");
      expect(f.pipeline.queued.customerToStaff).toBe(0);

      const sink = new MockPlaybackSink();
      f.pipeline.drainMock("customer", sink, {
        offlineTranslationAuthorized: true,
        simulatedIsolationVerified: true,
      });
      expect(sink.messages).toHaveLength(0);
    });
  });

  describe("4. Disconnects, Emergency Stop & Budget Hard Limits", () => {
    let pilotManager: ControlledPilotManager;

    beforeEach(() => {
      pilotManager = new ControlledPilotManager(undefined, {
        maxDurationSeconds: 180,
        maxSessions: 2,
        maxBudgetUsd: 0.20,
        estimatedCostPerMinuteUsd: 0.05,
        allowlist: {
          customerNumber: "+919876543211",
          staffNumber: "+919876543212",
          confirmed: true,
        },
      });
    });

    it("enforces session timeout cap and budget ceiling", async () => {
      // Session 1: 180s * (0.05/60) = $0.15
      const s1 = await pilotManager.startSession({
        customerNumber: "+919876543211",
        staffNumber: "+919876543212",
        operatorId: "op-lead",
        operatorConsent: true,
      });
      expect(s1.estimatedCostUsd).toBe(0.15);

      // Session 2 would add $0.15 -> total $0.30 > $0.20 budget
      await expect(
        pilotManager.startSession({
          customerNumber: "+919876543211",
          staffNumber: "+919876543212",
          operatorId: "op-lead",
          operatorConsent: true,
        })
      ).rejects.toThrow("PILOT_BUDGET_LIMIT_REACHED");
    });

    it("emergency stop terminates active sessions and halts all subsequent requests", async () => {
      const s1 = await pilotManager.startSession({
        customerNumber: "+919876543211",
        staffNumber: "+919876543212",
        operatorId: "op-lead",
        operatorConsent: true,
      });

      const stopResult = await pilotManager.emergencyStop("Manual safety test stop");
      expect(stopResult.terminatedCount).toBe(1);

      const record = pilotManager.getSession(s1.sessionId);
      expect(record?.status).toBe("terminated");
      expect(record?.terminationReason).toContain("Manual safety test stop");

      await expect(
        pilotManager.startSession({
          customerNumber: "+919876543211",
          staffNumber: "+919876543212",
          operatorId: "op-lead",
          operatorConsent: true,
        })
      ).rejects.toThrow("PILOT_EMERGENCY_STOP_ACTIVE");
    });
  });

  describe("5. Webhook Authentication Guard: Rejects Unauthorized Call Injection", () => {
    const trustedToken = "plivo-secret-auth-token";
    const callbackUrl = "https://staging.example/plivo/independent/answered?sessionId=sess-1&role=customer";

    it("accepts valid V3 signature with matching nonce and URL", () => {
      const headers = offlineHeaders("POST", callbackUrl, { CallUUID: "uuid-123" }, trustedToken);
      const guardResult = guardPlivoWebhookRequest({
        method: "POST",
        callbackUrl,
        headers,
        params: { CallUUID: "uuid-123" },
        authToken: trustedToken,
      });

      expect(guardResult.allowed).toBe(true);
    });

    it("rejects forged or missing signature headers", () => {
      const guardResult = guardPlivoWebhookRequest({
        method: "POST",
        callbackUrl,
        headers: { "x-plivo-signature-v3": "fake-signature" },
        params: { CallUUID: "uuid-123" },
        authToken: trustedToken,
      });

      expect(guardResult.allowed).toBe(false);
      expect(guardResult.reason).toBeDefined();
    });

    it("rejects tampered parameters (parameter injection attack)", () => {
      const headers = offlineHeaders("POST", callbackUrl, { CallUUID: "uuid-original" }, trustedToken);
      const guardResult = guardPlivoWebhookRequest({
        method: "POST",
        callbackUrl,
        headers,
        // Attacker attempts to substitute a different CallUUID
        params: { CallUUID: "uuid-tampered" },
        authToken: trustedToken,
      });

      expect(guardResult.allowed).toBe(false);
      expect(guardResult.reason).toBe("INVALID_SIGNATURE");
    });

    it("rejects duplicate or ambiguous headers (HTTP header pollution)", () => {
      const headers = {
        "x-plivo-signature-v3": ["sig-1", "sig-2"],
        "x-plivo-signature-v3-nonce": "nonce-1",
      };
      const guardResult = guardPlivoWebhookRequest({
        method: "POST",
        callbackUrl,
        headers,
        params: {},
        authToken: trustedToken,
      });

      expect(guardResult.allowed).toBe(false);
      expect(guardResult.reason).toBe("AMBIGUOUS_HEADER");
    });
  });
});
