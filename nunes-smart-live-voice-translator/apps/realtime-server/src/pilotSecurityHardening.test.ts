import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ReceiveOnlyPilotAuthorizer,
  type SingleUsePilotAuthorization,
} from "./receiveOnlyPilotAuthorization.js";
import {
  ControlledPilotManager,
  registerControlledPilotRoutes,
  type PilotAllowlist,
} from "./controlledPilotController.js";
import { OfflineIndependentCallProvider } from "./independentCallProvider.js";
import { IndependentCallOrchestrator } from "./independentCallOrchestrator.js";

describe("Controlled Live Pilot Security Hardening Suite", () => {
  const allowlist: PilotAllowlist = {
    customerNumber: "+919087768000",
    staffNumber: "+919159267000",
    confirmed: true,
  };

  let tempDir: string;
  let storageFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nunes-pilot-test-"));
    storageFile = path.join(tempDir, "pilot-auth.json");
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Cleanup best effort
    }
  });

  describe("1. Atomic Token Reservation & Concurrency Prevention", () => {
    it("locks token upon reservation and rejects concurrent attempts with the same token", () => {
      const authorizer = new ReceiveOnlyPilotAuthorizer(300);
      const auth = authorizer.issueAuthorization("op-lead", true, allowlist);

      // First reservation succeeds
      const res1 = authorizer.reserveAuthorization(
        auth.authorizationToken,
        allowlist.customerNumber,
        allowlist.staffNumber,
        allowlist
      );
      expect(res1.reservationId).toMatch(/^res-/);

      // Concurrent reservation attempt must fail immediately
      expect(() =>
        authorizer.reserveAuthorization(
          auth.authorizationToken,
          allowlist.customerNumber,
          allowlist.staffNumber,
          allowlist
        )
      ).toThrow("CONCURRENT_TOKEN_USE_DETECTED");
    });

    it("prevents racing concurrent startSession requests from dispatching duplicate calls", async () => {
      const provider = new OfflineIndependentCallProvider();
      const orchestrator = new IndependentCallOrchestrator({
        publicBaseUrl: "https://example.ngrok.io",
        fromNumber: "+911234567890",
        provider,
      });

      const manager = new ControlledPilotManager(orchestrator, {
        allowlist,
        maxDurationSeconds: 180,
      });

      const auth = manager.authorizer.issueAuthorization("op-lead", true, allowlist);

      // Launch two concurrent startSession requests with the exact same authorizationToken
      const p1 = manager.startSession({
        customerNumber: allowlist.customerNumber,
        staffNumber: allowlist.staffNumber,
        operatorId: "op-lead",
        operatorConsent: true,
        authorizationToken: auth.authorizationToken,
      });

      const p2 = manager.startSession({
        customerNumber: allowlist.customerNumber,
        staffNumber: allowlist.staffNumber,
        operatorId: "op-lead",
        operatorConsent: true,
        authorizationToken: auth.authorizationToken,
      });

      const results = await Promise.allSettled([p1, p2]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Exactly ONE request must succeed and ONE must be rejected
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason.message).toContain("CONCURRENT_TOKEN_USE_DETECTED");

      // Provider must have received exactly one pair of call legs (2 legs total, not 4)
      expect(provider.created).toHaveLength(2);
    });
  });

  describe("2. Idempotency Keys & Duplicate Prevention", () => {
    it("returns identical session record for repeated calls with same idempotency key without duplicate creation", async () => {
      const provider = new OfflineIndependentCallProvider();
      const orchestrator = new IndependentCallOrchestrator({
        publicBaseUrl: "https://example.ngrok.io",
        fromNumber: "+911234567890",
        provider,
      });

      const manager = new ControlledPilotManager(orchestrator, {
        allowlist,
        maxDurationSeconds: 180,
      });

      const auth = manager.authorizer.issueAuthorization("op-lead", true, allowlist);
      const idempotencyKey = "idem-key-unique-12345";

      const session1 = await manager.startSession({
        customerNumber: allowlist.customerNumber,
        staffNumber: allowlist.staffNumber,
        operatorId: "op-lead",
        operatorConsent: true,
        authorizationToken: auth.authorizationToken,
        idempotencyKey,
      });

      // Repeat with same idempotency key
      const session2 = await manager.startSession({
        customerNumber: allowlist.customerNumber,
        staffNumber: allowlist.staffNumber,
        operatorId: "op-lead",
        operatorConsent: true,
        authorizationToken: auth.authorizationToken,
        idempotencyKey,
      });

      expect(session1.sessionId).toBe(session2.sessionId);
      expect(session1.startedAt).toBe(session2.startedAt);
      expect(provider.created).toHaveLength(2); // Still only 2 legs created!
    });
  });

  describe("3. Partial Failure Invalidation & Anti-Retry Enforcement", () => {
    it("permanently invalidates token when provider call creation fails and blocks automatic retries", async () => {
      const provider = new OfflineIndependentCallProvider();
      provider.failRole = "customer"; // Force provider failure

      const orchestrator = new IndependentCallOrchestrator({
        publicBaseUrl: "https://example.ngrok.io",
        fromNumber: "+911234567890",
        provider,
      });

      const manager = new ControlledPilotManager(orchestrator, {
        allowlist,
        maxDurationSeconds: 180,
      });

      const auth = manager.authorizer.issueAuthorization("op-lead", true, allowlist);

      await expect(
        manager.startSession({
          customerNumber: allowlist.customerNumber,
          staffNumber: allowlist.staffNumber,
          operatorId: "op-lead",
          operatorConsent: true,
          authorizationToken: auth.authorizationToken,
        })
      ).rejects.toThrow("INDEPENDENT_PROVIDER_CREATE_FAILED");

      // Verify token is in failed state
      const record = manager.authorizer.getAuthorization(auth.authorizationToken);
      expect(record?.status).toBe("failed");
      expect(record?.failureReason).toBe("INDEPENDENT_PROVIDER_CREATE_FAILED");

      // Re-trying with the same token must fail with AUTHORIZATION_TOKEN_INVALIDATED
      provider.failRole = undefined; // Even if provider recovered, token is dead!
      await expect(
        manager.startSession({
          customerNumber: allowlist.customerNumber,
          staffNumber: allowlist.staffNumber,
          operatorId: "op-lead",
          operatorConsent: true,
          authorizationToken: auth.authorizationToken,
        })
      ).rejects.toThrow(/AUTHORIZATION_TOKEN_INVALIDATED/);
    });
  });

  describe("4. Durable State & Server Restart-Replay Prevention", () => {
    it("prevents replay of consumed authorization tokens across server restarts", () => {
      // 1. First server instance writes to storageFile
      const authorizer1 = new ReceiveOnlyPilotAuthorizer(300, Date.now, storageFile);
      const auth = authorizer1.issueAuthorization("op-lead", true, allowlist);

      authorizer1.consumeAuthorization(
        auth.authorizationToken,
        "session-pre-restart",
        allowlist.customerNumber,
        allowlist.staffNumber,
        allowlist
      );

      // Verify storage file was written
      expect(fs.existsSync(storageFile)).toBe(true);

      // 2. Second server instance boots and reads storageFile (simulating restart)
      const authorizer2 = new ReceiveOnlyPilotAuthorizer(300, Date.now, storageFile);

      // Attempting to consume the token on the new server instance must fail with ALREADY_CONSUMED
      expect(() =>
        authorizer2.consumeAuthorization(
          auth.authorizationToken,
          "session-post-restart",
          allowlist.customerNumber,
          allowlist.staffNumber,
          allowlist
        )
      ).toThrow("AUTHORIZATION_TOKEN_ALREADY_CONSUMED");
    });

    it("marks in-flight reserved tokens as failed upon server restart to avoid ambiguous retries", () => {
      const authorizer1 = new ReceiveOnlyPilotAuthorizer(300, Date.now, storageFile);
      const auth = authorizer1.issueAuthorization("op-lead", true, allowlist);

      // Reserve token but do NOT commit (simulating crash during call dispatch)
      authorizer1.reserveAuthorization(
        auth.authorizationToken,
        allowlist.customerNumber,
        allowlist.staffNumber,
        allowlist
      );

      // Server restarts
      const authorizer2 = new ReceiveOnlyPilotAuthorizer(300, Date.now, storageFile);

      const recovered = authorizer2.getAuthorization(auth.authorizationToken);
      expect(recovered?.status).toBe("failed");
      expect(recovered?.failureReason).toBe("SERVER_RESTARTED_DURING_RESERVATION");

      // Attempting to use the recovered token fails
      expect(() =>
        authorizer2.reserveAuthorization(
          auth.authorizationToken,
          allowlist.customerNumber,
          allowlist.staffNumber,
          allowlist
        )
      ).toThrow(/AUTHORIZATION_TOKEN_INVALIDATED/);
    });
  });

  describe("5. Token Privacy Invariants & Masking", () => {
    it("never exposes raw authorization token in session records, telemetry or status", async () => {
      const manager = new ControlledPilotManager(undefined, { allowlist });
      const auth = manager.authorizer.issueAuthorization("op-lead", true, allowlist);

      const session = await manager.startSession({
        customerNumber: allowlist.customerNumber,
        staffNumber: allowlist.staffNumber,
        operatorId: "op-lead",
        operatorConsent: true,
        authorizationToken: auth.authorizationToken,
      });

      // Raw token must NOT exist on session record
      expect((session as any).authorizationToken).toBeUndefined();

      // Telemetry must only expose authorizationTokenMasked
      const telem = manager.authorizer.getTelemetry(session.sessionId);
      expect((telem as any).authorizationToken).toBeUndefined();
      expect(telem!.authorizationTokenMasked).toMatch(/^auth-pilot-[0-9a-f]{4}\.\.\.[0-9a-f]{4}$/);
      expect(telem!.authorizationTokenMasked).not.toBe(auth.authorizationToken);
    });
  });
});

