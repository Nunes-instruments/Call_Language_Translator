import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ControlledPilotManager,
  registerControlledPilotRoutes,
  PILOT_SAFETY_GATES,
  type PilotAllowlist,
} from "./controlledPilotController.js";
import {
  OfflineIndependentCallProvider,
  type IndependentCallProvider,
} from "./independentCallProvider.js";
import { IndependentCallOrchestrator } from "./independentCallOrchestrator.js";
import { IndependentTranslationPipeline, MockPlaybackSink } from "./independentTranslationPipeline.js";
import { ScriptedSarvamMock } from "./sarvamPipelineAdapters.js";

describe("Final Pilot Integration Audit - Failure Modes, Teardown & Safety Gates", () => {
  const allowlist: PilotAllowlist = {
    customerNumber: "+919087768000",
    staffNumber: "+919159267000",
    confirmed: true,
  };

  describe("1. Partial Call Setup Failure & Token Preservation", () => {
    it("preserves authorization token when provider fails to create the second call leg", async () => {
      const provider = new OfflineIndependentCallProvider();
      // Configure provider to fail when attempting to create the staff leg
      provider.failRole = "staff";

      const orchestrator = new IndependentCallOrchestrator({
        publicBaseUrl: "https://example.ngrok.io",
        fromNumber: "+911234567890",
        provider,
      });

      const pilotManager = new ControlledPilotManager(orchestrator, {
        allowlist,
        maxDurationSeconds: 180,
      });

      const auth = pilotManager.authorizer.issueAuthorization("op-lead", true, allowlist);
      expect(auth.consumed).toBe(false);

      // Attempt session creation - must fail because staff leg fails
      await expect(
        pilotManager.startSession({
          customerNumber: allowlist.customerNumber,
          staffNumber: allowlist.staffNumber,
          operatorId: "op-lead",
          operatorConsent: true,
          authorizationToken: auth.authorizationToken,
        })
      ).rejects.toThrow("INDEPENDENT_PROVIDER_CREATE_FAILED");

      // Verify the authorization token was marked failed to prevent ambiguous retries
      const authRecord = pilotManager.authorizer.getAuthorization(auth.authorizationToken);
      expect(authRecord?.status).toBe("failed");

      // Attempting to retry with the same failed token must be blocked
      provider.failRole = undefined; // Provider recovers
      await expect(
        pilotManager.startSession({
          customerNumber: allowlist.customerNumber,
          staffNumber: allowlist.staffNumber,
          operatorId: "op-lead",
          operatorConsent: true,
          authorizationToken: auth.authorizationToken,
        })
      ).rejects.toThrow(/AUTHORIZATION_TOKEN_INVALIDATED/);

      // Operator must explicitly issue a fresh token for recovery
      const freshAuth = pilotManager.authorizer.issueAuthorization("op-lead", true, allowlist);
      const session = await pilotManager.startSession({
        customerNumber: allowlist.customerNumber,
        staffNumber: allowlist.staffNumber,
        operatorId: "op-lead",
        operatorConsent: true,
        authorizationToken: freshAuth.authorizationToken,
      });

      expect(session.sessionId).toBeDefined();
      expect(session.status).toBe("in-progress");
    });

    it("cleans up initial customer leg when subsequent staff leg creation fails", async () => {
      const provider = new OfflineIndependentCallProvider();
      provider.failRole = "staff";

      const orchestrator = new IndependentCallOrchestrator({
        publicBaseUrl: "https://example.ngrok.io",
        fromNumber: "+911234567890",
        provider,
      });

      const pilotManager = new ControlledPilotManager(orchestrator, {
        allowlist,
        maxDurationSeconds: 180,
      });

      const auth = pilotManager.authorizer.issueAuthorization("op-lead", true, allowlist);

      await expect(
        pilotManager.startSession({
          customerNumber: allowlist.customerNumber,
          staffNumber: allowlist.staffNumber,
          operatorId: "op-lead",
          operatorConsent: true,
          authorizationToken: auth.authorizationToken,
        })
      ).rejects.toThrow("INDEPENDENT_PROVIDER_CREATE_FAILED");

      // Customer leg was created before staff failed
      expect(provider.created).toHaveLength(1);
      expect(provider.created[0].role).toBe("customer");

      // And customer leg was immediately queued and stopped via provider.stopLeg
      expect(provider.stopped).toHaveLength(1);
      expect(provider.stopped[0].requestUuid).toBe(provider.created[0].requestUuid);
    });
  });

  describe("2. Emergency Stop Provider-Side Teardown", () => {
    it("actively calls provider.stopLeg for all active call legs on emergency stop", async () => {
      const provider = new OfflineIndependentCallProvider();
      const orchestrator = new IndependentCallOrchestrator({
        publicBaseUrl: "https://example.ngrok.io",
        fromNumber: "+911234567890",
        provider,
      });

      const pilotManager = new ControlledPilotManager(orchestrator, {
        allowlist,
        maxDurationSeconds: 180,
      });

      const auth = pilotManager.authorizer.issueAuthorization("op-lead", true, allowlist);
      const session = await pilotManager.startSession({
        customerNumber: allowlist.customerNumber,
        staffNumber: allowlist.staffNumber,
        operatorId: "op-lead",
        operatorConsent: true,
        authorizationToken: auth.authorizationToken,
      });

      expect(provider.created).toHaveLength(2); // customer + staff
      expect(provider.stopped).toHaveLength(0);

      // Trigger emergency stop
      const stopResult = await pilotManager.emergencyStop("SAFETY_HAZARD_DETECTED");
      expect(stopResult.terminatedCount).toBe(1);

      // Both call legs must have been stopped via provider
      expect(provider.stopped).toHaveLength(2);
      const stoppedRequestUuids = provider.stopped.map((s) => s.requestUuid);
      expect(stoppedRequestUuids).toContain(provider.created[0].requestUuid);
      expect(stoppedRequestUuids).toContain(provider.created[1].requestUuid);

      // Verify session status is terminated
      const record = pilotManager.getSession(session.sessionId);
      expect(record?.status).toBe("terminated");
      expect(record?.terminationReason).toContain("SAFETY_HAZARD_DETECTED");

      // Verify all further session creations are blocked
      await expect(
        pilotManager.startSession({
          customerNumber: allowlist.customerNumber,
          staffNumber: allowlist.staffNumber,
          operatorId: "op-lead",
          operatorConsent: true,
        })
      ).rejects.toThrow("PILOT_EMERGENCY_STOP_ACTIVE");
    });
  });

  describe("3. Disconnects, Stale Sockets & Sweeper Teardown", () => {
    it("marks stream stopped in telemetry and cleans up on stream stop event", async () => {
      let currentTime = 1_000_000;
      const provider = new OfflineIndependentCallProvider();
      const orchestrator = new IndependentCallOrchestrator({
        publicBaseUrl: "https://example.ngrok.io",
        fromNumber: "+911234567890",
        provider,
        now: () => currentTime,
      });

      const pilotManager = new ControlledPilotManager(
        orchestrator,
        { allowlist, maxDurationSeconds: 180 },
        () => currentTime
      );

      const auth = pilotManager.authorizer.issueAuthorization("op-lead", true, allowlist);
      const session = await pilotManager.startSession({
        customerNumber: allowlist.customerNumber,
        staffNumber: allowlist.staffNumber,
        operatorId: "op-lead",
        operatorConsent: true,
        authorizationToken: auth.authorizationToken,
      });

      const mockSocket = { close: () => {} };
      (orchestrator as any).sockets.set(`${session.sessionId}:customer`, {
        socket: mockSocket,
        openedAt: currentTime,
        streamId: "stream-cust-abc",
        started: false,
      });

      orchestrator.manager.registerCall(session.sessionId, "customer", "call-cust-abc");
      orchestrator.manager.registerStream(session.sessionId, "customer", "call-cust-abc", "stream-cust-abc");
      orchestrator.streamStarted(session.sessionId, "customer", "stream-cust-abc");

      // Ingest a packet at t=1000000
      const payloadBase64 = Buffer.alloc(160, 0x7f).toString("base64");
      orchestrator.media(session.sessionId, "customer", mockSocket, {
        streamId: "stream-cust-abc",
        sequenceNumber: 1,
        media: { track: "inbound", payload: payloadBase64 },
      });

      // Stream stops at t=1000500
      currentTime += 500;
      orchestrator.streamStopped(session.sessionId, "customer", "stream-cust-abc");

      const telemetry = pilotManager.authorizer.getTelemetry(session.sessionId);
      expect(telemetry?.customerLeg?.stoppedAt).toBe(1_000_500);
      expect(telemetry?.customerLeg?.totalPackets).toBe(1);

      // Retired stream replay must be rejected
      expect(() =>
        orchestrator.assertStreamAllowed(session.sessionId, "customer", "stream-cust-abc")
      ).toThrow("RETIRED_STREAM_REPLAY");
    });

    it("terminates orphaned sessions when reconnect grace timeout expires during sweep", async () => {
      let currentTime = 1_000_000;
      const provider = new OfflineIndependentCallProvider();
      const orchestrator = new IndependentCallOrchestrator({
        publicBaseUrl: "https://example.ngrok.io",
        fromNumber: "+911234567890",
        provider,
        now: () => currentTime,
        reconnectGraceMs: 30_000,
      });

      const created = await orchestrator.create({
        customerNumber: allowlist.customerNumber,
        staffNumber: allowlist.staffNumber,
      });

      const mockSocket = { close: () => {} };
      (orchestrator as any).sockets.set(`${created.sessionId}:customer`, {
        socket: mockSocket,
        openedAt: currentTime,
        streamId: "stream-cust-1",
        started: true,
      });

      // Customer leg disconnects at t=1000000
      orchestrator.disconnectSocket(created.sessionId, "customer", mockSocket);

      // Sweep before timeout (20s later) - session remains open
      currentTime += 20_000;
      await orchestrator.sweep();
      expect(orchestrator.describe(created.sessionId).state).not.toBe("closed");

      // Sweep after timeout (35s total disconnect) - session closes with reconnect-timeout
      currentTime += 15_000;
      await orchestrator.sweep();
      expect(orchestrator.describe(created.sessionId).state).toBe("closed");
      expect(orchestrator.describe(created.sessionId).closeReason).toBe("reconnect-timeout");
    });
  });

  describe("4. Absolute Audio Isolation & Zero Egress Verification", () => {
    it("guarantees direct bypass is blocked and production playback throws AUDIO_ISOLATION_UNVERIFIED", () => {
      const mockSarvam = new ScriptedSarvamMock();
      const pipeline = new IndependentTranslationPipeline("test-iso-sess", mockSarvam);

      expect(() => pipeline.productionPlayback()).toThrow("AUDIO_ISOLATION_UNVERIFIED");
      expect(pipeline.gates).toEqual({
        documentationContractVerified: true,
        offlineSimulationIsolation: true,
        actualAudioIsolationVerified: false,
        productionTranslationAuthorized: false,
      });
    });

    it("verifies telemetry container strictly maintains false for raw audio and transcript storage", () => {
      const pilotManager = new ControlledPilotManager(undefined, { allowlist });
      const auth = pilotManager.authorizer.issueAuthorization("op-lead", true, allowlist);

      pilotManager.authorizer.consumeAuthorization(
        auth.authorizationToken,
        "sess-iso-audit",
        allowlist.customerNumber,
        allowlist.staffNumber,
        allowlist
      );

      const telem = pilotManager.authorizer.getTelemetry("sess-iso-audit");
      expect(telem).toBeDefined();
      expect(telem!.rawAudioRetained).toBe(false);
      expect(telem!.transcriptsRetained).toBe(false);
      expect(telem!.outboundAudioTransmitted).toBe(false);
    });
  });
});

