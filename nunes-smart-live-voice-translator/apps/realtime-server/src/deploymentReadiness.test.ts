import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  ReceiveOnlyPilotAuthorizer,
  type SingleUsePilotAuthorization,
} from "./receiveOnlyPilotAuthorization.js";
import {
  ControlledPilotManager,
  type PilotAllowlist,
} from "./controlledPilotController.js";
import type { IndependentCallOrchestrator } from "./independentCallOrchestrator.js";

const VALID_ALLOWLIST: PilotAllowlist = Object.freeze({
  customerNumber: "+919087768000",
  staffNumber: "+919159267000",
  confirmed: true,
});

describe("Deployment Readiness & Pilot Concurrency Tests", () => {
  let tmpDir: string;
  let storageFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nunes-deploy-test-"));
    storageFile = path.join(tmpDir, "pilot-auth.json");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("1. Concurrency & Multi-Process Simulation", () => {
    it("rejects concurrent reservations with identical token across two independent authorizer instances sharing file storage", () => {
      const authorizerA = new ReceiveOnlyPilotAuthorizer(300, Date.now, storageFile);
      const authorizerB = new ReceiveOnlyPilotAuthorizer(300, Date.now, storageFile);
      const auth = authorizerA.issueAuthorization("op-alpha", true, VALID_ALLOWLIST);

      // Instance A reserves the token
      const resA = authorizerA.reserveAuthorization(
        auth.authorizationToken,
        VALID_ALLOWLIST.customerNumber,
        VALID_ALLOWLIST.staffNumber,
        VALID_ALLOWLIST
      );
      expect(resA.reservationId).toBeDefined();

      // Instance B immediately attempts to reserve the same token
      expect(() => {
        authorizerB.reserveAuthorization(
          auth.authorizationToken,
          VALID_ALLOWLIST.customerNumber,
          VALID_ALLOWLIST.staffNumber,
          VALID_ALLOWLIST
        );
      }).toThrow("CONCURRENT_TOKEN_USE_DETECTED");
    });

    it("allows idempotent re-reservation with identical idempotencyKey across instances", () => {
      const authorizerA = new ReceiveOnlyPilotAuthorizer(300, Date.now, storageFile);
      const authorizerB = new ReceiveOnlyPilotAuthorizer(300, Date.now, storageFile);
      const auth = authorizerA.issueAuthorization("op-alpha", true, VALID_ALLOWLIST);

      const idempotencyKey = "idem-deploy-key-999";
      const resA = authorizerA.reserveAuthorization(
        auth.authorizationToken,
        VALID_ALLOWLIST.customerNumber,
        VALID_ALLOWLIST.staffNumber,
        VALID_ALLOWLIST,
        idempotencyKey
      );

      const resB = authorizerB.reserveAuthorization(
        auth.authorizationToken,
        VALID_ALLOWLIST.customerNumber,
        VALID_ALLOWLIST.staffNumber,
        VALID_ALLOWLIST,
        idempotencyKey
      );

      expect(resB.reservationId).toBe(resA.reservationId);
    });
  });

  describe("2. Atomic File Persistence & Corrupted File Recovery", () => {
    it("uses atomic write pattern and cleans up any temp files upon normal save", () => {
      const authorizer = new ReceiveOnlyPilotAuthorizer(300, Date.now, storageFile);
      authorizer.issueAuthorization("op-1", true, VALID_ALLOWLIST);

      expect(fs.existsSync(storageFile)).toBe(true);
      const files = fs.readdirSync(tmpDir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles.length).toBe(0);

      const raw = fs.readFileSync(storageFile, "utf8");
      const parsed = JSON.parse(raw);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(1);
    });

    it("safely backs up corrupted file and fails safe to empty state without throwing", () => {
      // Write corrupted non-JSON data
      fs.writeFileSync(storageFile, "{ corrupted malformed json invalid syntax ...", "utf8");

      let authorizer: ReceiveOnlyPilotAuthorizer | undefined;
      expect(() => {
        authorizer = new ReceiveOnlyPilotAuthorizer(300, Date.now, storageFile);
      }).not.toThrow();

      // Corrupted file was backed up
      const files = fs.readdirSync(tmpDir);
      const backupFile = files.find((f) => f.includes(".corrupted."));
      expect(backupFile).toBeDefined();

      // Authorizer continues cleanly
      const auth = authorizer!.issueAuthorization("op-recovered", true, VALID_ALLOWLIST);
      expect(auth.authorizationToken).toBeDefined();
    });
  });

  describe("3. Process Restart & In-Flight Reservation Recovery", () => {
    it("invalidates tokens that were in 'reserved' state when server abruptly restarted", () => {
      const authorizer = new ReceiveOnlyPilotAuthorizer(300, Date.now, storageFile);
      const auth = authorizer.issueAuthorization("op-1", true, VALID_ALLOWLIST);

      authorizer.reserveAuthorization(
        auth.authorizationToken,
        VALID_ALLOWLIST.customerNumber,
        VALID_ALLOWLIST.staffNumber,
        VALID_ALLOWLIST
      );

      // Verify it was stored as reserved
      const rawBefore = JSON.parse(fs.readFileSync(storageFile, "utf8"));
      expect(rawBefore[0].status).toBe("reserved");

      // Server restarts: new instance loads disk
      const restartedAuthorizer = new ReceiveOnlyPilotAuthorizer(300, Date.now, storageFile);
      const loaded = restartedAuthorizer.getAuthorization(auth.authorizationToken);

      expect(loaded?.status).toBe("failed");
      expect(loaded?.failureReason).toBe("SERVER_RESTARTED_DURING_RESERVATION");

      // Attempting to reserve or commit fails
      expect(() => {
        restartedAuthorizer.reserveAuthorization(
          auth.authorizationToken,
          VALID_ALLOWLIST.customerNumber,
          VALID_ALLOWLIST.staffNumber,
          VALID_ALLOWLIST
        );
      }).toThrow("AUTHORIZATION_TOKEN_INVALIDATED: SERVER_RESTARTED_DURING_RESERVATION");
    });
  });

  describe("4. Emergency Stop During Partial Call Setup & Quota Enforcement", () => {
    it("terminates all active and pending sessions during emergency stop and closes provider legs", async () => {
      const mockOrchestrator = {
        create: vi.fn().mockResolvedValue({ sessionId: "orch-sess-100" }),
        close: vi.fn().mockResolvedValue(undefined),
        setTelemetryListener: vi.fn(),
      } as unknown as IndependentCallOrchestrator;

      const manager = new ControlledPilotManager(mockOrchestrator, {
        allowlist: VALID_ALLOWLIST,
        storagePath: storageFile,
      });

      const auth = manager.authorizer.issueAuthorization("op-test", true, VALID_ALLOWLIST);
      const session = await manager.startSession({
        customerNumber: VALID_ALLOWLIST.customerNumber,
        staffNumber: VALID_ALLOWLIST.staffNumber,
        operatorId: "op-test",
        operatorConsent: true,
        authorizationToken: auth.authorizationToken,
      });

      expect(session.status).toBe("in-progress");
      expect(manager.getStatus().activeSessionsCount).toBe(1);

      // Operator triggers emergency stop
      const stopResult = await manager.emergencyStop("SAFETY_INTERVENTION");
      expect(stopResult.terminatedCount).toBe(1);
      expect(manager.getStatus().emergencyStopEngaged).toBe(true);
      expect(manager.getStatus().activeSessionsCount).toBe(0);
      expect(mockOrchestrator.close).toHaveBeenCalledWith("orch-sess-100", expect.stringMatching(/safety_intervention/i));

      // Any new session attempt is rejected
      await expect(
        manager.startSession({
          customerNumber: VALID_ALLOWLIST.customerNumber,
          staffNumber: VALID_ALLOWLIST.staffNumber,
          operatorId: "op-test-2",
          operatorConsent: true,
        })
      ).rejects.toThrow("PILOT_EMERGENCY_STOP_ACTIVE");
    });

    it("strictly blocks production translation activation", () => {
      const manager = new ControlledPilotManager(undefined, { allowlist: VALID_ALLOWLIST });
      expect(() => manager.activateProductionTranslation()).toThrow("AUDIO_ISOLATION_UNVERIFIED");
      expect(manager.gates.actualAudioIsolationVerified).toBe(false);
      expect(manager.gates.productionTranslationAuthorized).toBe(false);
      expect(manager.gates.livePlayback).toBe("BLOCKED");
      expect(manager.gates.originalBypass).toBe("BLOCKED");
    });
  });
});
