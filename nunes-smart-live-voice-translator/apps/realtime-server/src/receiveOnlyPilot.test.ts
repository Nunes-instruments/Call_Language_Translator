import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ReceiveOnlyPilotAuthorizer,
  type ReceiveOnlyPilotSessionTelemetry,
} from "./receiveOnlyPilotAuthorization.js";
import {
  ControlledPilotManager,
  registerControlledPilotRoutes,
  PILOT_SAFETY_GATES,
  maskPhoneNumber,
} from "./controlledPilotController.js";
import { OfflineIndependentCallProvider } from "./independentCallProvider.js";
import { IndependentCallOrchestrator } from "./independentCallOrchestrator.js";

describe("Receive-Only Controlled Pilot Authorization & Telemetry", () => {
  const allowlist = {
    customerNumber: "+919087768000",
    staffNumber: "+919159267000",
    confirmed: true,
  };

  describe("1. Single-Use Expiring Authorization Token Lifecycle", () => {
    it("issues a valid expiring authorization token with masked privacy guarantees", () => {
      let currentTime = 1_000_000;
      const authorizer = new ReceiveOnlyPilotAuthorizer(300, () => currentTime);

      const auth = authorizer.issueAuthorization("op-lead-1", true, allowlist);

      expect(auth.authorizationToken).toMatch(/^auth-pilot-[0-9a-f]{48}$/);
      expect(auth.authorizationTokenMasked).toMatch(/^auth-pilot-[0-9a-f]{4}\.\.\.[0-9a-f]{4}$/);
      expect(auth.operatorId).toBe("op-lead-1");
      expect(auth.consumed).toBe(false);
      expect(auth.issuedAt).toBe(1_000_000);
      expect(auth.expiresAt).toBe(1_000_000 + 300 * 1000);
      expect(auth.targetCustomerMasked).toBe(maskPhoneNumber(allowlist.customerNumber));
      expect(auth.targetStaffMasked).toBe(maskPhoneNumber(allowlist.staffNumber));
    });

    it("requires explicit operator consent and valid operator ID", () => {
      const authorizer = new ReceiveOnlyPilotAuthorizer();

      expect(() =>
        authorizer.issueAuthorization("op-lead", false, allowlist)
      ).toThrow("OPERATOR_CONSENT_REQUIRED");

      expect(() =>
        authorizer.issueAuthorization("", true, allowlist)
      ).toThrow("OPERATOR_ID_REQUIRED");

      expect(() =>
        authorizer.issueAuthorization("   ", true, allowlist)
      ).toThrow("OPERATOR_ID_REQUIRED");
    });

    it("rejects issuance if allowlist is incomplete or missing", () => {
      const authorizer = new ReceiveOnlyPilotAuthorizer();

      expect(() =>
        authorizer.issueAuthorization("op-lead", true, null as any)
      ).toThrow("PILOT_ALLOWLIST_REQUIRED");

      expect(() =>
        authorizer.issueAuthorization("op-lead", true, { customerNumber: "", staffNumber: "", confirmed: true })
      ).toThrow("PILOT_ALLOWLIST_REQUIRED");
    });

    it("consumes authorization exactly once and rejects replays", () => {
      let currentTime = 1_000_000;
      const authorizer = new ReceiveOnlyPilotAuthorizer(300, () => currentTime);
      const auth = authorizer.issueAuthorization("op-lead", true, allowlist);

      const consumed = authorizer.consumeAuthorization(
        auth.authorizationToken,
        "pilot-sess-100",
        allowlist.customerNumber,
        allowlist.staffNumber,
        allowlist
      );

      expect(consumed.consumed).toBe(true);
      expect(consumed.sessionId).toBe("pilot-sess-100");
      expect(consumed.consumedAt).toBe(currentTime);

      // Second consumption must fail with AUTHORIZATION_TOKEN_ALREADY_CONSUMED
      expect(() =>
        authorizer.consumeAuthorization(
          auth.authorizationToken,
          "pilot-sess-101",
          allowlist.customerNumber,
          allowlist.staffNumber,
          allowlist
        )
      ).toThrow("AUTHORIZATION_TOKEN_ALREADY_CONSUMED");
    });

    it("rejects consumption of expired authorization tokens", () => {
      let currentTime = 1_000_000;
      const authorizer = new ReceiveOnlyPilotAuthorizer(300, () => currentTime);
      const auth = authorizer.issueAuthorization("op-lead", true, allowlist);

      // Fast-forward past expiry (300s = 300,000ms)
      currentTime += 300_001;

      expect(() =>
        authorizer.consumeAuthorization(
          auth.authorizationToken,
          "pilot-sess-102",
          allowlist.customerNumber,
          allowlist.staffNumber,
          allowlist
        )
      ).toThrow("AUTHORIZATION_TOKEN_EXPIRED");
    });

    it("rejects invalid, malformed, or nonexistent tokens", () => {
      const authorizer = new ReceiveOnlyPilotAuthorizer();

      expect(() =>
        authorizer.consumeAuthorization(
          "",
          "sess-1",
          allowlist.customerNumber,
          allowlist.staffNumber,
          allowlist
        )
      ).toThrow("AUTHORIZATION_TOKEN_REQUIRED");

      expect(() =>
        authorizer.consumeAuthorization(
          "auth-pilot-nonexistent-token",
          "sess-1",
          allowlist.customerNumber,
          allowlist.staffNumber,
          allowlist
        )
      ).toThrow("AUTHORIZATION_TOKEN_INVALID");
    });

    it("rejects consumption when numbers do not match configured allowlist", () => {
      const authorizer = new ReceiveOnlyPilotAuthorizer();
      const auth = authorizer.issueAuthorization("op-lead", true, allowlist);

      expect(() =>
        authorizer.consumeAuthorization(
          auth.authorizationToken,
          "sess-1",
          "+919999999999", // Unallowlisted number
          allowlist.staffNumber,
          allowlist
        )
      ).toThrow("UNAUTHORIZED_PILOT_PHONE_NUMBER");

      expect(() =>
        authorizer.consumeAuthorization(
          auth.authorizationToken,
          "sess-1",
          allowlist.customerNumber,
          "+919999999999", // Unallowlisted staff number
          allowlist
        )
      ).toThrow("UNAUTHORIZED_PILOT_PHONE_NUMBER");
    });
  });

  describe("2. Receive-Only Telemetry & Strict Data Privacy Invariants", () => {
    it("guarantees raw audio, transcripts, and outbound audio are never stored or transmitted", () => {
      const authorizer = new ReceiveOnlyPilotAuthorizer();
      const auth = authorizer.issueAuthorization("op-lead", true, allowlist);

      authorizer.consumeAuthorization(
        auth.authorizationToken,
        "sess-privacy-check",
        allowlist.customerNumber,
        allowlist.staffNumber,
        allowlist
      );

      const telemetry = authorizer.getTelemetry("sess-privacy-check");
      expect(telemetry).toBeDefined();
      expect(telemetry!.rawAudioRetained).toBe(false);
      expect(telemetry!.transcriptsRetained).toBe(false);
      expect(telemetry!.outboundAudioTransmitted).toBe(false);
    });

    it("accurately records stream start, packet sequence gaps, jitter intervals, and stream stop", () => {
      let currentTime = 1_000_000;
      const authorizer = new ReceiveOnlyPilotAuthorizer(300, () => currentTime);
      const auth = authorizer.issueAuthorization("op-lead", true, allowlist);

      authorizer.consumeAuthorization(
        auth.authorizationToken,
        "sess-packet-test",
        allowlist.customerNumber,
        allowlist.staffNumber,
        allowlist
      );

      // Start customer leg stream
      authorizer.recordStreamStart("sess-packet-test", "customer", "stream-cust-001");

      // Ingest packet 0 at t=1000000, 160 bytes (20ms μ-law @ 8kHz)
      authorizer.recordPacketTelemetry("sess-packet-test", "customer", "stream-cust-001", 0, 160);

      // Ingest packet 1 at t=1000020 (+20ms interval)
      currentTime += 20;
      authorizer.recordPacketTelemetry("sess-packet-test", "customer", "stream-cust-001", 1, 160);

      // Ingest packet 2 at t=1000045 (+25ms interval)
      currentTime += 25;
      authorizer.recordPacketTelemetry("sess-packet-test", "customer", "stream-cust-001", 2, 160);

      // Ingest packet 5 (skipping 3 and 4 -> sequence gap) at t=1000105 (+60ms interval)
      currentTime += 60;
      authorizer.recordPacketTelemetry("sess-packet-test", "customer", "stream-cust-001", 5, 160);

      // Stop stream
      currentTime += 50;
      authorizer.recordStreamStop("sess-packet-test", "customer", "stream-cust-001");
      authorizer.closeSessionTelemetry("sess-packet-test");

      const telemetry = authorizer.getTelemetry("sess-packet-test");
      expect(telemetry).toBeDefined();
      expect(telemetry!.closedAt).toBe(currentTime);

      const customerLeg = telemetry!.customerLeg!;
      expect(customerLeg.streamId).toBe("stream-cust-001");
      expect(customerLeg.role).toBe("customer");
      expect(customerLeg.totalPackets).toBe(4);
      expect(customerLeg.totalBytes).toBe(640);
      expect(customerLeg.lastSequence).toBe(5);
      expect(customerLeg.sequenceGaps).toBe(1); // One jump from 2 to 5
      expect(customerLeg.minIntervalMs).toBe(20);
      expect(customerLeg.maxIntervalMs).toBe(60);
      expect(customerLeg.intervalsCount).toBe(3);
      expect(customerLeg.averageIntervalMs).toBe(35); // (20 + 25 + 60) / 3 = 35.00
      expect(customerLeg.stoppedAt).toBe(currentTime);
    });
  });

  describe("3. Controlled Pilot Manager & HTTP Route Integration", () => {
    let app: FastifyInstance;
    let manager: ControlledPilotManager;
    const adminPassword = "secret-pilot-admin-key";

    beforeEach(async () => {
      manager = new ControlledPilotManager(undefined, {
        allowlist,
        maxDurationSeconds: 180,
        maxSessions: 5,
        maxBudgetUsd: 2.0,
      });

      app = Fastify();
      await registerControlledPilotRoutes(app, {
        manager,
        adminPassword,
      });
      await app.ready();
    });

    it("POST /management/pilot/authorize requires authentication and issues token", async () => {
      // Unauthenticated request should fail 401
      const unauth = await app.inject({
        method: "POST",
        url: "/management/pilot/authorize",
        payload: { operatorId: "op-1", operatorConsent: true },
      });
      expect(unauth.statusCode).toBe(401);

      // Authenticated request succeeds
      const res = await app.inject({
        method: "POST",
        url: "/management/pilot/authorize",
        headers: { authorization: `Bearer ${adminPassword}` },
        payload: { operatorId: "op-lead-qa", operatorConsent: true },
      });
      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      expect(data.authorizationToken).toMatch(/^auth-pilot-/);
      expect(data.operatorId).toBe("op-lead-qa");
      expect(data.targetCustomerMasked).toBe(maskPhoneNumber(allowlist.customerNumber));
      expect(data.targetStaffMasked).toBe(maskPhoneNumber(allowlist.staffNumber));
    });

    it("POST /management/pilot/sessions consumes token and verifies telemetry retrieval", async () => {
      // 1. Issue token
      const authRes = await app.inject({
        method: "POST",
        url: "/management/pilot/authorize",
        headers: { authorization: `Bearer ${adminPassword}` },
        payload: { operatorId: "op-lead-qa", operatorConsent: true },
      });
      const { authorizationToken } = JSON.parse(authRes.body);

      // 2. Start session using token
      const startRes = await app.inject({
        method: "POST",
        url: "/management/pilot/sessions",
        headers: { authorization: `Bearer ${adminPassword}` },
        payload: {
          customerNumber: allowlist.customerNumber,
          staffNumber: allowlist.staffNumber,
          operatorId: "op-lead-qa",
          operatorConsent: true,
          authorizationToken,
        },
      });
      expect(startRes.statusCode).toBe(201);
      const session = JSON.parse(startRes.body);
      expect(session.sessionId).toBeDefined();

      // 3. Attempting to start another session with same token must fail
      const replayRes = await app.inject({
        method: "POST",
        url: "/management/pilot/sessions",
        headers: { authorization: `Bearer ${adminPassword}` },
        payload: {
          customerNumber: allowlist.customerNumber,
          staffNumber: allowlist.staffNumber,
          operatorId: "op-lead-qa",
          operatorConsent: true,
          authorizationToken,
        },
      });
      expect(replayRes.statusCode).toBe(500);
      expect(JSON.parse(replayRes.body).error).toBe("AUTHORIZATION_TOKEN_ALREADY_CONSUMED");

      // 4. Retrieve telemetry for session
      const telemRes = await app.inject({
        method: "GET",
        url: `/management/pilot/telemetry/${session.sessionId}`,
        headers: { authorization: `Bearer ${adminPassword}` },
      });
      expect(telemRes.statusCode).toBe(200);
      const telemetry = JSON.parse(telemRes.body) as ReceiveOnlyPilotSessionTelemetry;
      expect(telemetry.sessionId).toBe(session.sessionId);
      expect(telemetry.rawAudioRetained).toBe(false);
      expect(telemetry.transcriptsRetained).toBe(false);
      expect(telemetry.outboundAudioTransmitted).toBe(false);
    });

    it("production translation activation remains strictly blocked with AUDIO_ISOLATION_UNVERIFIED", () => {
      expect(() => manager.activateProductionTranslation()).toThrow("AUDIO_ISOLATION_UNVERIFIED");
      const status = manager.getStatus();
      expect(status.gates).toEqual(PILOT_SAFETY_GATES);
      expect(status.gates.actualAudioIsolationVerified).toBe(false);
      expect(status.gates.productionTranslationAuthorized).toBe(false);
      expect(status.gates.livePlayback).toBe("BLOCKED");
      expect(status.gates.originalBypass).toBe("BLOCKED");
    });
  });

  describe("4. End-to-End Orchestrator Telemetry Dispatch", () => {
    it("dispatches stream start and packet telemetry through orchestrator to authorizer", async () => {
      const orchestrator = new IndependentCallOrchestrator({
        publicBaseUrl: "https://example.ngrok.io",
        fromNumber: "+911234567890",
        provider: new OfflineIndependentCallProvider(),
      });

      const pilotManager = new ControlledPilotManager(orchestrator, {
        allowlist,
        maxDurationSeconds: 180,
      });

      const auth = pilotManager.authorizer.issueAuthorization("op-pilot", true, allowlist);

      const session = await pilotManager.startSession({
        customerNumber: allowlist.customerNumber,
        staffNumber: allowlist.staffNumber,
        operatorId: "op-pilot",
        operatorConsent: true,
        authorizationToken: auth.authorizationToken,
      });

      // Create a mock socket
      const mockSocket = { close: () => {} };
      (orchestrator as any).sockets.set(`${session.sessionId}:customer`, {
        socket: mockSocket,
        openedAt: Date.now(),
        streamId: "stream-c-999",
        started: false,
      });

      // Register call and stream in manager so orchestrator.media passes ownership validation
      orchestrator.manager.registerCall(session.sessionId, "customer", "call-c-999");
      orchestrator.manager.registerStream(session.sessionId, "customer", "call-c-999", "stream-c-999");

      // Simulate stream start callback for customer leg
      orchestrator.streamStarted(session.sessionId, "customer", "stream-c-999");

      // Send a valid media packet (20ms mulaw = 160 bytes, base64 length ~ 216 chars)
      const payloadBase64 = Buffer.alloc(160, 0x7f).toString("base64");
      orchestrator.media(session.sessionId, "customer", mockSocket, {
        streamId: "stream-c-999",
        sequenceNumber: 1,
        media: {
          track: "inbound",
          payload: payloadBase64,
        },
      });

      // Verify packet was recorded in authorizer telemetry
      const telemetry = pilotManager.authorizer.getTelemetry(session.sessionId);
      expect(telemetry).toBeDefined();
      expect(telemetry!.customerLeg).toBeDefined();
      expect(telemetry!.customerLeg!.streamId).toBe("stream-c-999");
      expect(telemetry!.customerLeg!.totalPackets).toBe(1);
      expect(telemetry!.customerLeg!.totalBytes).toBe(160);
      expect(telemetry!.customerLeg!.lastSequence).toBe(1);

      // Terminate session
      await pilotManager.terminateSession(session.sessionId, "PILOT_TEST_COMPLETED");
      const finalTelem = pilotManager.authorizer.getTelemetry(session.sessionId);
      expect(finalTelem!.closedAt).toBeDefined();
    });
  });
});
