import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  IndependentTranslationPipeline,
  MockPlaybackSink,
  type AudioOwner,
  type TranslationPipelineObserver,
} from "./independentTranslationPipeline.js";
import {
  RealisticOfflineTranslationProvider,
  createDialogueFixtures,
} from "./realisticOfflineTranslationProvider.js";
import { IndependentCallOrchestrator } from "./independentCallOrchestrator.js";
import { OfflineIndependentCallProvider } from "./independentCallProvider.js";
import { ControlledPilotManager } from "./controlledPilotController.js";
import { decodeMulaw, encodeMulaw } from "./telephonyAudioCodec.js";

const fixtures = createDialogueFixtures();

describe("Functional Tamil <-> Hindi Translation Pipeline", () => {
  it("executes Customer Hindi Speech -> Tamil Text -> Tamil Speech synthesized for Staff", async () => {
    const provider = new RealisticOfflineTranslationProvider();
    const transcripts: any[] = [];
    const translations: any[] = [];
    const synthesized: any[] = [];
    const prepared: any[] = [];

    const observer: TranslationPipelineObserver = {
      onTranscript: (e) => transcripts.push(e),
      onTranslation: (e) => translations.push(e),
      onSynthesized: (e) => synthesized.push(e),
      onAudioPrepared: (e) => prepared.push(e),
    };

    const pipeline = new IndependentTranslationPipeline("sess-turn1", provider, {
      timeoutMs: 1000,
      customGlossary: ["Fluke 754", "4-20 mA"],
      observer,
    });

    const customer: AudioOwner = { sessionId: "sess-turn1", role: "customer", callUuid: "c1", streamId: "s-cust", socket: {} };
    const staff: AudioOwner = { sessionId: "sess-turn1", role: "staff", callUuid: "c2", streamId: "s-staff", socket: {} };
    pipeline.bind(customer);
    pipeline.bind(staff);

    // Stream 20ms frames (160 bytes each) of customer Hindi inquiry
    const mulaw = fixtures.customerHindi.audioMulaw;
    const chunkSize = 160;
    let seq = 1;
    for (let offset = 0; offset < mulaw.length; offset += chunkSize) {
      const chunk = mulaw.subarray(offset, Math.min(offset + chunkSize, mulaw.length));
      pipeline.receive(customer, seq++, chunk.toString("base64"));
    }
    // Finalize utterance with silence
    pipeline.receive(customer, seq++, Buffer.alloc(2400, 255).toString("base64"));
    await pipeline.idle();

    // Assertions
    expect(transcripts.length).toBe(1);
    expect(transcripts[0].role).toBe("customer");
    expect(transcripts[0].language).toBe("hi-IN");
    expect(transcripts[0].text).toContain("Fluke 754");

    expect(translations.length).toBe(1);
    expect(translations[0].role).toBe("customer");
    expect(translations[0].sourceLanguage).toBe("hi-IN");
    expect(translations[0].targetLanguage).toBe("ta-IN");
    expect(translations[0].translatedText).toContain("Fluke 754");
    expect(translations[0].translatedText).toContain("4-20 mA");

    expect(synthesized.length).toBe(1);
    expect(synthesized[0].destination).toBe("staff");
    expect(synthesized[0].audioBytes).toBeGreaterThan(0);

    expect(prepared.length).toBe(1);
    expect(prepared[0].destination).toBe("staff");
    expect(pipeline.metrics.prepared).toBe(1);
  });

  it("executes Staff Tamil Speech -> Hindi Text -> Hindi Speech synthesized for Customer", async () => {
    const provider = new RealisticOfflineTranslationProvider();
    const transcripts: any[] = [];
    const translations: any[] = [];
    const synthesized: any[] = [];
    const prepared: any[] = [];

    const observer: TranslationPipelineObserver = {
      onTranscript: (e) => transcripts.push(e),
      onTranslation: (e) => translations.push(e),
      onSynthesized: (e) => synthesized.push(e),
      onAudioPrepared: (e) => prepared.push(e),
    };

    const pipeline = new IndependentTranslationPipeline("sess-turn2", provider, {
      timeoutMs: 1000,
      customGlossary: ["Fluke 754", "GST"],
      observer,
    });

    const customer: AudioOwner = { sessionId: "sess-turn2", role: "customer", callUuid: "c1", streamId: "s-cust", socket: {} };
    const staff: AudioOwner = { sessionId: "sess-turn2", role: "staff", callUuid: "c2", streamId: "s-staff", socket: {} };
    pipeline.bind(customer);
    pipeline.bind(staff);

    // First establish customer Hindi context
    provider.queueTranscript({
      text: fixtures.customerHindi.transcriptText,
      language: "hi-IN",
      confidence: 0.99,
      final: true,
    });
    pipeline.receive(customer, 1, fixtures.customerHindi.audioMulaw.subarray(0, 1600).toString("base64"));
    pipeline.flush("customer");
    await pipeline.idle();

    // Now Staff speaks Tamil response
    provider.queueTranscript({
      text: fixtures.staffTamil.transcriptText,
      language: "ta-IN",
      confidence: 0.99,
      final: true,
    });
    pipeline.receive(staff, 2, fixtures.staffTamil.audioMulaw.toString("base64"));
    pipeline.receive(staff, 3, Buffer.alloc(2400, 255).toString("base64"));
    await pipeline.idle();

    // Verify Staff translation to Customer
    const staffTranslation = translations.find((t) => t.role === "staff");
    expect(staffTranslation).toBeDefined();
    expect(staffTranslation.sourceLanguage).toBe("ta-IN");
    expect(staffTranslation.targetLanguage).toBe("hi-IN");
    expect(staffTranslation.translatedText).toContain("Fluke 754");
    expect(staffTranslation.translatedText).toContain("GST 18%");

    const custOutput = synthesized.find((s) => s.destination === "customer");
    expect(custOutput).toBeDefined();
    expect(custOutput.audioBytes).toBeGreaterThan(0);
  });

  it("locks employee language to Tamil and holds conflicting staff Hindi language", async () => {
    const provider = new RealisticOfflineTranslationProvider();
    const pipeline = new IndependentTranslationPipeline("sess-lock", provider);
    const customer: AudioOwner = { sessionId: "sess-lock", role: "customer", callUuid: "c1", streamId: "s-cust", socket: {} };
    const staff: AudioOwner = { sessionId: "sess-lock", role: "staff", callUuid: "c2", streamId: "s-staff", socket: {} };
    pipeline.bind(customer);
    pipeline.bind(staff);

    // Customer speaks Hindi
    provider.queueTranscript({ text: "नमस्ते", language: "hi-IN", confidence: 0.95, final: true });
    pipeline.receive(customer, 1, fixtures.customerHindi.audioMulaw.subarray(0, 1600).toString("base64"));
    pipeline.flush("customer");
    await pipeline.idle();

    // Staff speaks Hindi (conflicting with locked Tamil staff language)
    provider.queueTranscript({ text: "हाँ कहिए", language: "hi-IN", confidence: 0.95, final: true });
    pipeline.receive(staff, 2, fixtures.customerHindi.audioMulaw.subarray(0, 1600).toString("base64"));
    pipeline.flush("staff");
    await pipeline.idle();

    // Conflicting staff Hindi speech must be held safely
    expect(pipeline.metrics.held).toBeGreaterThanOrEqual(1);
    expect(pipeline.queued.staffToCustomer).toBe(0);
  });

  it("handles barge-in interruption by cancelling in-flight work and clearing pending audio", async () => {
    const provider = new RealisticOfflineTranslationProvider();
    let bargeInRole: string | undefined;

    const pipeline = new IndependentTranslationPipeline("sess-barge", provider, {
      observer: {
        onBargeIn: (e) => { bargeInRole = e.role; },
      },
    });

    const customer: AudioOwner = { sessionId: "sess-barge", role: "customer", callUuid: "c1", streamId: "s-cust", socket: {} };
    const staff: AudioOwner = { sessionId: "sess-barge", role: "staff", callUuid: "c2", streamId: "s-staff", socket: {} };
    pipeline.bind(customer);
    pipeline.bind(staff);

    // Customer speaks and finishes translation
    provider.queueTranscript({ text: fixtures.customerHindi.transcriptText, language: "hi-IN", confidence: 0.95, final: true });
    pipeline.receive(customer, 1, fixtures.customerHindi.audioMulaw.toString("base64"));
    pipeline.receive(customer, 2, Buffer.alloc(2400, 255).toString("base64"));
    await pipeline.idle();

    // Audio is queued destined for staff
    expect(pipeline.queued.customerToStaff).toBe(1);

    // Staff interrupts (speaks voiced frame)
    pipeline.receive(staff, 1, fixtures.staffTamil.audioMulaw.subarray(0, 320).toString("base64"));

    // Barge-in cancels pending playback destined for staff
    expect(bargeInRole).toBe("staff");
    expect(pipeline.queued.customerToStaff).toBe(0);
  });

  it("suppresses simulated echo frame received within 1500ms", async () => {
    const provider = new RealisticOfflineTranslationProvider();
    let echoSuppressed = false;

    const pipeline = new IndependentTranslationPipeline("sess-echo", provider, {
      observer: {
        onEchoSuppressed: () => { echoSuppressed = true; },
      },
    });

    const customer: AudioOwner = { sessionId: "sess-echo", role: "customer", callUuid: "c1", streamId: "s-cust", socket: {} };
    const staff: AudioOwner = { sessionId: "sess-echo", role: "staff", callUuid: "c2", streamId: "s-staff", socket: {} };
    pipeline.bind(customer);
    pipeline.bind(staff);

    // Establish translation to staff
    provider.queueTranscript({ text: fixtures.customerHindi.transcriptText, language: "hi-IN", confidence: 0.95, final: true });
    pipeline.receive(customer, 1, fixtures.customerHindi.audioMulaw.toString("base64"));
    pipeline.receive(customer, 2, Buffer.alloc(2400, 255).toString("base64"));
    await pipeline.idle();

    // Drain playback to mock sink
    const sink = new MockPlaybackSink();
    pipeline.drainMock("customer", sink, { offlineTranslationAuthorized: true, simulatedIsolationVerified: true });
    const playedAudio = Buffer.from(sink.messages[0].media!.payload, "base64");

    // Opposite leg (staff) hears playback and mic echoes it back
    pipeline.receive(staff, 1, playedAudio.toString("base64"));

    expect(pipeline.metrics.echoSuppressed).toBe(1);
    expect(echoSuppressed).toBe(true);
  });

  it("enforces Tamil <-> Tamil direct bypass mode behind its safety gate", async () => {
    // 1. Safety Gate Active (allowDirectBypass = false): fails closed with ORIGINAL_AUDIO_PATH_UNVERIFIED
    const provider1 = new RealisticOfflineTranslationProvider();
    const pipelineBlocked = new IndependentTranslationPipeline("sess-direct-block", provider1, {
      allowDirectBypass: false,
    });
    const customer1: AudioOwner = { sessionId: "sess-direct-block", role: "customer", callUuid: "c1", streamId: "s-cust", socket: {} };
    const staff1: AudioOwner = { sessionId: "sess-direct-block", role: "staff", callUuid: "c2", streamId: "s-staff", socket: {} };
    pipelineBlocked.bind(customer1);
    pipelineBlocked.bind(staff1);

    provider1.queueTranscript({
      text: fixtures.customerTamilDirect.transcriptText,
      language: "ta-IN",
      confidence: 0.99,
      final: true,
    });
    pipelineBlocked.receive(customer1, 1, fixtures.customerTamilDirect.audioMulaw.toString("base64"));
    pipelineBlocked.receive(customer1, 2, Buffer.alloc(2400, 255).toString("base64"));
    await pipelineBlocked.idle();

    expect(pipelineBlocked.router.getMode()).toBe("DIRECT_BYPASS");
    expect(pipelineBlocked.metrics.lastError).toBe("ORIGINAL_AUDIO_PATH_UNVERIFIED");
    expect(pipelineBlocked.metrics.held).toBeGreaterThan(0);

    // 2. Safety Gate Authorized in test mode (allowDirectBypass = true): routes directly without translation
    const provider2 = new RealisticOfflineTranslationProvider();
    const pipelineAllowed = new IndependentTranslationPipeline("sess-direct-allow", provider2, {
      allowDirectBypass: true,
    });
    const customer2: AudioOwner = { sessionId: "sess-direct-allow", role: "customer", callUuid: "c1", streamId: "s-cust", socket: {} };
    const staff2: AudioOwner = { sessionId: "sess-direct-allow", role: "staff", callUuid: "c2", streamId: "s-staff", socket: {} };
    pipelineAllowed.bind(customer2);
    pipelineAllowed.bind(staff2);

    provider2.queueTranscript({
      text: fixtures.customerTamilDirect.transcriptText,
      language: "ta-IN",
      confidence: 0.99,
      final: true,
    });
    pipelineAllowed.receive(customer2, 1, fixtures.customerTamilDirect.audioMulaw.toString("base64"));
    pipelineAllowed.receive(customer2, 2, Buffer.alloc(2400, 255).toString("base64"));
    await pipelineAllowed.idle();

    expect(pipelineAllowed.router.getMode()).toBe("DIRECT_BYPASS");
    expect(pipelineAllowed.metrics.prepared).toBe(1);
    expect(provider2.calls.translation).toBe(0); // Zero translation called in direct bypass!
  });

  it("orchestrates two-leg call with offline provider and dispatches Plivo playAudio WebSocket frames", async () => {
    const provider = new RealisticOfflineTranslationProvider();
    const sentMessages: Record<string, string[]> = { customer: [], staff: [] };

    const mockCustomerSocket = {
      send: (data: string) => sentMessages.customer.push(data),
      close: vi.fn(),
    };
    const mockStaffSocket = {
      send: (data: string) => sentMessages.staff.push(data),
      close: vi.fn(),
    };

    const orchestrator = new IndependentCallOrchestrator({
      publicBaseUrl: "https://example.ngrok.io",
      fromNumber: "+911234567890",
      provider: new OfflineIndependentCallProvider(),
      offlineTranslationProviders: provider,
      customGlossary: ["Fluke 754", "4-20 mA"],
      dispatchOfflinePlayback: true,
    });

    const session = await orchestrator.create({
      customerNumber: "+919087768000",
      staffNumber: "+919159267000",
    });

    const callUuidCustomer = "call-cust-uuid-001";
    const callUuidStaff = "call-staff-uuid-002";

    orchestrator.manager.registerCall(session.sessionId, "customer", callUuidCustomer);
    orchestrator.manager.registerCall(session.sessionId, "staff", callUuidStaff);
    orchestrator.manager.registerStream(session.sessionId, "customer", callUuidCustomer, "stream-cust-001");
    orchestrator.manager.registerStream(session.sessionId, "staff", callUuidStaff, "stream-staff-001");

    // Simulate Plivo WebSockets opening and starting
    const tokenCustomer = (orchestrator as any).runtime.get(session.sessionId).tokens.customer;
    const tokenStaff = (orchestrator as any).runtime.get(session.sessionId).tokens.staff;

    orchestrator.openSocket(session.sessionId, "customer", tokenCustomer, mockCustomerSocket as any);
    orchestrator.openSocket(session.sessionId, "staff", tokenStaff, mockStaffSocket as any);

    orchestrator.startSocket(session.sessionId, "customer", mockCustomerSocket as any, {
      callId: callUuidCustomer,
      streamId: "stream-cust-001",
      tracks: ["inbound"],
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000 },
    });
    orchestrator.startSocket(session.sessionId, "staff", mockStaffSocket as any, {
      callId: callUuidStaff,
      streamId: "stream-staff-001",
      tracks: ["inbound"],
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000 },
    });

    // Customer sends audio packets via Plivo media event
    provider.queueTranscript({
      text: fixtures.customerHindi.transcriptText,
      language: "hi-IN",
      confidence: 0.99,
      final: true,
    });

    orchestrator.media(session.sessionId, "customer", mockCustomerSocket as any, {
      event: "media",
      streamId: "stream-cust-001",
      sequenceNumber: 1,
      media: {
        track: "inbound",
        payload: fixtures.customerHindi.audioMulaw.subarray(0, 1600).toString("base64"),
      },
    });

    // Send silence to trigger flush
    orchestrator.media(session.sessionId, "customer", mockCustomerSocket as any, {
      event: "media",
      streamId: "stream-cust-001",
      sequenceNumber: 2,
      media: {
        track: "inbound",
        payload: Buffer.alloc(2400, 255).toString("base64"),
      },
    });

    const pipeline = (orchestrator as any).runtime.get(session.sessionId).translation;
    await pipeline.idle();

    // Verify Staff received Plivo playAudio message
    expect(sentMessages.staff.length).toBeGreaterThan(0);
    const parsedPlay = JSON.parse(sentMessages.staff[0]);
    expect(parsedPlay.event).toBe("playAudio");
    expect(parsedPlay.streamId).toBe("stream-staff-001");
    expect(parsedPlay.media.contentType).toBe("audio/x-mulaw");
    expect(parsedPlay.media.sampleRate).toBe(8000);
    expect(parsedPlay.media.payload).toBeDefined();

    await orchestrator.close(session.sessionId, "test-complete");
  });
});
