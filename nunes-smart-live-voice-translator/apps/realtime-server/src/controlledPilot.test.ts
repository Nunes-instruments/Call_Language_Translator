import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  ControlledPilotManager,
  registerControlledPilotRoutes,
  maskPhoneNumber,
  type PilotAllowlist,
} from "./controlledPilotController.js";

const testAllowlist: PilotAllowlist = {
  customerNumber: "+919876543211",
  staffNumber: "+919876543212",
};

describe("Controlled Pilot Manager - Unit & Safeguards", () => {
  let manager: ControlledPilotManager;

  beforeEach(() => {
    manager = new ControlledPilotManager(undefined, {
      maxDurationSeconds: 180,
      maxSessions: 3,
      maxBudgetUsd: 1.0,
      estimatedCostPerMinuteUsd: 0.05,
      allowlist: testAllowlist,
    });
  });

  it("masks phone numbers properly without exposing private middle digits", () => {
    expect(maskPhoneNumber("+919876543211")).toBe("+********3211");
    expect(maskPhoneNumber("+1234567890")).toBe("+******7890");
    expect(maskPhoneNumber("1234")).toBe("****");
    expect(maskPhoneNumber("")).toBe("****");
  });

  it("requires operator consent and operator ID", async () => {
    await expect(
      manager.startSession({
        customerNumber: testAllowlist.customerNumber,
        staffNumber: testAllowlist.staffNumber,
        operatorId: "",
        operatorConsent: true,
      })
    ).rejects.toThrow("OPERATOR_ID_REQUIRED");

    await expect(
      manager.startSession({
        customerNumber: testAllowlist.customerNumber,
        staffNumber: testAllowlist.staffNumber,
        operatorId: "op-1",
        operatorConsent: false,
      })
    ).rejects.toThrow("OPERATOR_CONSENT_REQUIRED");
  });

  it("rejects unauthorized, non-allowlisted phone numbers", async () => {
    await expect(
      manager.startSession({
        customerNumber: "+919999999999", // not in allowlist
        staffNumber: testAllowlist.staffNumber,
        operatorId: "op-1",
        operatorConsent: true,
      })
    ).rejects.toThrow("UNAUTHORIZED_PILOT_PHONE_NUMBER");

    await expect(
      manager.startSession({
        customerNumber: testAllowlist.customerNumber,
        staffNumber: "+918888888888", // not in allowlist
        operatorId: "op-1",
        operatorConsent: true,
      })
    ).rejects.toThrow("UNAUTHORIZED_PILOT_PHONE_NUMBER");
  });

  it("starts session with allowlisted numbers and records masked telemetry", async () => {
    const session = await manager.startSession({
      customerNumber: testAllowlist.customerNumber,
      staffNumber: testAllowlist.staffNumber,
      operatorId: "op-lead",
      operatorConsent: true,
    });

    expect(session.sessionId).toBeDefined();
    expect(session.customerNumberMasked).toBe("+********3211");
    expect(session.staffNumberMasked).toBe("+********3212");
    expect(session.status).toBe("in-progress");
    expect(session.operatorId).toBe("op-lead");

    const status = manager.getStatus();
    expect(status.activeSessionsCount).toBe(1);
    expect(status.totalSessionsCreated).toBe(1);
    expect(status.cumulativeEstimatedCostUsd).toBeGreaterThan(0);
  });

  it("enforces spending and session count limits", async () => {
    // 3 sessions max configured
    await manager.startSession({
      customerNumber: testAllowlist.customerNumber,
      staffNumber: testAllowlist.staffNumber,
      operatorId: "op-1",
      operatorConsent: true,
    });
    await manager.startSession({
      customerNumber: testAllowlist.customerNumber,
      staffNumber: testAllowlist.staffNumber,
      operatorId: "op-1",
      operatorConsent: true,
    });
    await manager.startSession({
      customerNumber: testAllowlist.customerNumber,
      staffNumber: testAllowlist.staffNumber,
      operatorId: "op-1",
      operatorConsent: true,
    });

    // 4th session must fail
    await expect(
      manager.startSession({
        customerNumber: testAllowlist.customerNumber,
        staffNumber: testAllowlist.staffNumber,
        operatorId: "op-1",
        operatorConsent: true,
      })
    ).rejects.toThrow("PILOT_SESSION_LIMIT_REACHED");
  });

  it("triggers emergency stop and terminates in-flight sessions immediately", async () => {
    const s1 = await manager.startSession({
      customerNumber: testAllowlist.customerNumber,
      staffNumber: testAllowlist.staffNumber,
      operatorId: "op-1",
      operatorConsent: true,
    });

    const stopResult = await manager.emergencyStop("Acoustic anomaly detected");
    expect(stopResult.terminatedCount).toBe(1);

    const updated = manager.getSession(s1.sessionId);
    expect(updated?.status).toBe("terminated");
    expect(updated?.terminationReason).toContain("Acoustic anomaly detected");

    // Any new session attempt is blocked
    await expect(
      manager.startSession({
        customerNumber: testAllowlist.customerNumber,
        staffNumber: testAllowlist.staffNumber,
        operatorId: "op-1",
        operatorConsent: true,
      })
    ).rejects.toThrow("PILOT_EMERGENCY_STOP_ACTIVE");

    // Resetting emergency stop allows new sessions again
    manager.resetEmergencyStop();
    expect(manager.getStatus().emergencyStopEngaged).toBe(false);
  });

  it("preserves safety gates and blocks production translation activation", () => {
    expect(manager.gates.actualAudioIsolationVerified).toBe(false);
    expect(manager.gates.productionTranslationAuthorized).toBe(false);
    expect(manager.gates.livePlayback).toBe("BLOCKED");
    expect(manager.gates.originalBypass).toBe("BLOCKED");

    expect(() => manager.activateProductionTranslation()).toThrow("AUDIO_ISOLATION_UNVERIFIED");
  });

  it("verifies productionPlayback unconditionally throws and field-verification is strictly gated", async () => {
    const { IndependentTranslationPipeline, MockPlaybackSink } = await import("./independentTranslationPipeline.js");
    const { ScriptedSarvamMock } = await import("./sarvamPipelineAdapters.js");

    const mock = new ScriptedSarvamMock();
    const pipeline = new IndependentTranslationPipeline("test-session", mock);

    // 1. productionPlayback unconditionally throws AUDIO_ISOLATION_UNVERIFIED
    expect(() => pipeline.productionPlayback()).toThrow("AUDIO_ISOLATION_UNVERIFIED");

    // 2. drainFieldVerification fails closed without full authorization
    const sink = new MockPlaybackSink();
    expect(() =>
      pipeline.drainFieldVerification("customer", sink, {
        operatorConsent: false,
        operatorId: "op-1",
        allowlistVerified: true,
        sessionDurationCapped: true,
        auditToken: "tok-123",
      })
    ).toThrow("FIELD_VERIFICATION_GATE_CLOSED");

    expect(() =>
      pipeline.drainFieldVerification("customer", sink, {
        operatorConsent: true,
        operatorId: "",
        allowlistVerified: true,
        sessionDurationCapped: true,
        auditToken: "tok-123",
      })
    ).toThrow("FIELD_VERIFICATION_GATE_CLOSED");

    expect(() =>
      pipeline.drainFieldVerification("customer", sink, {
        operatorConsent: true,
        operatorId: "op-1",
        allowlistVerified: false,
        sessionDurationCapped: true,
        auditToken: "tok-123",
      })
    ).toThrow("FIELD_VERIFICATION_GATE_CLOSED");

    // 3. drainFieldVerification succeeds when fully authorized
    expect(() =>
      pipeline.drainFieldVerification("customer", sink, {
        operatorConsent: true,
        operatorId: "op-1",
        allowlistVerified: true,
        sessionDurationCapped: true,
        auditToken: "tok-123",
      })
    ).not.toThrow();
  });
});

describe("Controlled Pilot Routes - Fastify HTTP API", () => {
  const adminPassword = "secret-pilot-admin";
  const authHeader = { authorization: `Bearer ${adminPassword}` };

  async function createTestApp() {
    const app = Fastify();
    const manager = new ControlledPilotManager(undefined, {
      allowlist: testAllowlist,
      maxSessions: 5,
    });
    await registerControlledPilotRoutes(app, { manager, adminPassword });
    await app.ready();
    return { app, manager };
  }

  it("rejects unauthorized access without admin bearer token", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/management/pilot/status",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns pilot status for authenticated admin", async () => {
    const { app } = await createTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/management/pilot/status",
      headers: authHeader,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pilotReady).toBe(true);
    expect(body.allowlistConfigured).toBe(true);
    expect(body.gates.actualAudioIsolationVerified).toBe(false);
  });

  it("creates a controlled pilot session via HTTP and validates allowlist", async () => {
    const { app } = await createTestApp();

    // 1. Rejected if numbers not allowlisted
    const rejectRes = await app.inject({
      method: "POST",
      url: "/management/pilot/sessions",
      headers: authHeader,
      payload: {
        customerNumber: "+911111111111",
        staffNumber: testAllowlist.staffNumber,
        operatorId: "op-test",
        operatorConsent: true,
      },
    });
    expect(rejectRes.statusCode).toBe(403);
    expect(rejectRes.json().error).toBe("UNAUTHORIZED_PILOT_PHONE_NUMBER");

    // 2. Accepted when allowlisted
    const passRes = await app.inject({
      method: "POST",
      url: "/management/pilot/sessions",
      headers: authHeader,
      payload: {
        customerNumber: testAllowlist.customerNumber,
        staffNumber: testAllowlist.staffNumber,
        operatorId: "op-test",
        operatorConsent: true,
      },
    });
    expect(passRes.statusCode).toBe(201);
    const session = passRes.json();
    expect(session.sessionId).toBeDefined();
    expect(session.status).toBe("in-progress");

    // 3. Emergency stop via HTTP
    const stopRes = await app.inject({
      method: "POST",
      url: "/management/pilot/emergency-stop",
      headers: authHeader,
      payload: { reason: "Operator test stop" },
    });
    expect(stopRes.statusCode).toBe(200);
    expect(stopRes.json().emergencyStopEngaged).toBe(true);
    expect(stopRes.json().terminatedCount).toBe(1);
  });

  it("updates and validates allowlist via HTTP POST with E.164 and operator confirmation", async () => {
    const { app, manager } = await createTestApp();

    // 1. Rejects if not confirmed
    const unconfirmedRes = await app.inject({
      method: "POST",
      url: "/management/pilot/allowlist",
      headers: authHeader,
      payload: {
        customerNumber: "+919876543299",
        staffNumber: "+919876543288",
        confirmed: false,
      },
    });
    expect(unconfirmedRes.statusCode).toBe(400);
    expect(unconfirmedRes.json().error).toBe("ALLOWLIST_CONFIRMATION_REQUIRED");

    // 2. Rejects invalid customer Indian E.164
    const invalidCustomerRes = await app.inject({
      method: "POST",
      url: "/management/pilot/allowlist",
      headers: authHeader,
      payload: {
        customerNumber: "9876543299", // missing +91
        staffNumber: "+919876543288",
        confirmed: true,
      },
    });
    expect(invalidCustomerRes.statusCode).toBe(400);
    expect(invalidCustomerRes.json().error).toBe("INVALID_CUSTOMER_E164_PHONE");

    // 3. Rejects invalid staff Indian E.164
    const invalidStaffRes = await app.inject({
      method: "POST",
      url: "/management/pilot/allowlist",
      headers: authHeader,
      payload: {
        customerNumber: "+919876543299",
        staffNumber: "+1234567890", // not Indian (+91)
        confirmed: true,
      },
    });
    expect(invalidStaffRes.statusCode).toBe(400);
    expect(invalidStaffRes.json().error).toBe("INVALID_STAFF_E164_PHONE");

    // 4. Rejects duplicate customer and staff numbers
    const dupRes = await app.inject({
      method: "POST",
      url: "/management/pilot/allowlist",
      headers: authHeader,
      payload: {
        customerNumber: "+919876543299",
        staffNumber: "+919876543299",
        confirmed: true,
      },
    });
    expect(dupRes.statusCode).toBe(400);
    expect(dupRes.json().error).toBe("DUPLICATE_ALLOWLIST_NUMBERS");

    // 5. Successfully updates allowlist when valid and confirmed
    const successRes = await app.inject({
      method: "POST",
      url: "/management/pilot/allowlist",
      headers: authHeader,
      payload: {
        customerNumber: "+919876543299",
        staffNumber: "+919876543288",
        confirmed: true,
      },
    });
    expect(successRes.statusCode).toBe(200);
    expect(successRes.json().success).toBe(true);
    expect(successRes.json().allowlist).toEqual({
      customer: "+********3299",
      staff: "+********3288",
    });

    // Verify status returns the updated masked allowlist
    const statusRes = await app.inject({
      method: "GET",
      url: "/management/pilot/status",
      headers: authHeader,
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().allowlistMasked).toEqual({
      customer: "+********3299",
      staff: "+********3288",
    });
  });

  it("consistently initializes allowlist from environment config across server restarts", () => {
    // 1. Manager with configured allowlist in config (simulating NUNES_PILOT_* env vars on restart)
    const envConfiguredManager = new ControlledPilotManager(undefined, {
      allowlist: {
        customerNumber: "+919087768000",
        staffNumber: "+919159267000",
      },
    });

    const status = envConfiguredManager.getStatus();
    expect(status.allowlistConfigured).toBe(true);
    expect(status.pilotReady).toBe(true);
    expect(status.allowlistMasked).toEqual({
      customer: "+********8000",
      staff: "+********7000",
    });

    // 2. Manager without configured allowlist starts unconfigured until set via API
    const unconfiguredManager = new ControlledPilotManager(undefined, {});
    expect(unconfiguredManager.getStatus().allowlistConfigured).toBe(false);
    expect(unconfiguredManager.getStatus().pilotReady).toBe(false);
    expect(unconfiguredManager.getStatus().allowlistMasked).toBeNull();
  });
});


