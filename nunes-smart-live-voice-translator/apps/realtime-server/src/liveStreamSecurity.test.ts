import { describe, expect, it, vi } from "vitest";
import {
  LiveStreamSecurityManager,
  validateMulaw8kAudio,
} from "./liveStreamSecurity.js";
import { encodeMulaw } from "./telephonyAudioCodec.js";

function createMockSocket(open = true) {
  return {
    readyState: open ? 1 : 3, // 1: OPEN, 3: CLOSED
    send: vi.fn(),
    close: vi.fn(),
  };
}

function createSampleMulawAudio(sampleCount = 160): Buffer {
  // 160 samples = 20ms of 8kHz audio
  const pcm = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    pcm[i] = Math.round(1000 * Math.sin((2 * Math.PI * 440 * i) / 8000));
  }
  return encodeMulaw(pcm);
}

describe("LiveStreamSecurityManager & Audio Safety", () => {
  it("generates cryptographic connection tokens and validates constant-time matching", () => {
    const manager = new LiveStreamSecurityManager();
    const session = manager.createSession({
      sessionId: "session-auth-1",
      customerPhone: "+919087768000",
      staffPhone: "+919159267000",
    });

    expect(session.customerToken).toBeDefined();
    expect(session.staffToken).toBeDefined();
    expect(session.customerToken).not.toBe(session.staffToken);
    expect(session.customerToken.length).toBeGreaterThanOrEqual(32);

    // Valid tokens match
    expect(manager.validateToken("session-auth-1", "customer", session.customerToken)).toBe(true);
    expect(manager.validateToken("session-auth-1", "staff", session.staffToken)).toBe(true);

    // Cross-role tokens are rejected
    expect(manager.validateToken("session-auth-1", "customer", session.staffToken)).toBe(false);
    expect(manager.validateToken("session-auth-1", "staff", session.customerToken)).toBe(false);

    // Tampered tokens are rejected
    expect(manager.validateToken("session-auth-1", "customer", session.customerToken + "tampered")).toBe(false);
    expect(manager.validateToken("session-auth-1", "customer", "invalid-token")).toBe(false);

    // Unknown sessions are rejected
    expect(manager.validateToken("unknown-session", "customer", session.customerToken)).toBe(false);
  });

  it("prevents duplicate active sockets on the same call leg", () => {
    const manager = new LiveStreamSecurityManager();
    manager.createSession({
      sessionId: "session-dup-1",
      customerPhone: "+919087768000",
      staffPhone: "+919159267000",
    });

    // First attachment is allowed
    const firstCheck = manager.assertCanAttachSocket("session-dup-1", "customer");
    expect(firstCheck.allowed).toBe(true);

    const firstSocket = createMockSocket(true);
    manager.attachSocket("session-dup-1", "customer", firstSocket);

    // Second active socket on the same leg is rejected with 409
    const secondCheck = manager.assertCanAttachSocket("session-dup-1", "customer");
    expect(secondCheck.allowed).toBe(false);
    expect(secondCheck.status).toBe(409);
    expect(secondCheck.reason).toBe("DUPLICATE_ACTIVE_SOCKET");

    // But opposite leg (staff) is independent and allowed
    const staffCheck = manager.assertCanAttachSocket("session-dup-1", "staff");
    expect(staffCheck.allowed).toBe(true);

    // If first socket closes, reconnect is allowed
    firstSocket.readyState = 3; // CLOSED
    const reconnectCheck = manager.assertCanAttachSocket("session-dup-1", "customer");
    expect(reconnectCheck.allowed).toBe(true);
  });

  it("prevents stream hijacking by rejecting attempts to change an attached streamId", () => {
    const manager = new LiveStreamSecurityManager();
    manager.createSession({
      sessionId: "session-hijack-1",
      customerPhone: "+919087768000",
      staffPhone: "+919159267000",
    });

    // Attach legitimate stream
    const firstAttach = manager.attachStream("session-hijack-1", "customer", "plivo-stream-leg-1", "call-leg-1");
    expect(firstAttach.allowed).toBe(true);

    // Re-attaching the same streamId is idempotent and allowed
    const sameAttach = manager.attachStream("session-hijack-1", "customer", "plivo-stream-leg-1");
    expect(sameAttach.allowed).toBe(true);

    // Attempting to hijack the leg with a different streamId is rejected
    const hijackAttach = manager.attachStream("session-hijack-1", "customer", "attacker-injected-stream-id");
    expect(hijackAttach.allowed).toBe(false);
    expect(hijackAttach.reason).toBe("STREAM_HIJACKING_ATTEMPT");
  });

  it("validates media frames against stream ownership and valid audio payload", () => {
    const manager = new LiveStreamSecurityManager();
    manager.createSession({
      sessionId: "session-media-1",
      customerPhone: "+919087768000",
      staffPhone: "+919159267000",
    });

    manager.attachStream("session-media-1", "customer", "customer-stream-100");

    const validAudio = createSampleMulawAudio(160);
    const validBase64 = validAudio.toString("base64");

    // Valid packet with matching streamId
    const validPacket = manager.validateMediaPacket(
      "session-media-1",
      "customer",
      "customer-stream-100",
      validBase64
    );
    expect(validPacket.allowed).toBe(true);
    expect(validPacket.bytes?.length).toBe(160);

    // Packet with mismatched streamId is rejected
    const mismatchedPacket = manager.validateMediaPacket(
      "session-media-1",
      "customer",
      "wrong-stream-999",
      validBase64
    );
    expect(mismatchedPacket.allowed).toBe(false);
    expect(mismatchedPacket.reason).toBe("STREAM_ID_MISMATCH");

    // Packet with empty payload is rejected
    const emptyPacket = manager.validateMediaPacket(
      "session-media-1",
      "customer",
      "customer-stream-100",
      ""
    );
    expect(emptyPacket.allowed).toBe(false);

    // Packet before stream is attached is rejected
    const unattachedPacket = manager.validateMediaPacket(
      "session-media-1",
      "staff",
      "staff-stream-200",
      validBase64
    );
    expect(unattachedPacket.allowed).toBe(false);
    expect(unattachedPacket.reason).toBe("STREAM_NOT_ATTACHED");
  });

  it("strictly validates genuine 8 kHz G.711 mu-law audio buffers", () => {
    const validAudio = createSampleMulawAudio(160);
    expect(validateMulaw8kAudio(validAudio)).toBe(true);

    // Empty buffer is rejected
    expect(validateMulaw8kAudio(Buffer.alloc(0))).toBe(false);

    // Non-buffer is rejected
    expect(validateMulaw8kAudio("audio" as any)).toBe(false);
    expect(validateMulaw8kAudio(null as any)).toBe(false);

    // Excessively large buffer (> 80k) is rejected
    expect(validateMulaw8kAudio(Buffer.alloc(80_001))).toBe(false);
  });

  it("enforces playback gating: blocks playback when unverified or unapproved", () => {
    const manager = new LiveStreamSecurityManager();
    manager.createSession({
      sessionId: "session-gate-1",
      customerPhone: "+919087768000",
      staffPhone: "+919159267000",
    });

    const staffSocket = createMockSocket(true);
    manager.attachSocket("session-gate-1", "staff", staffSocket);
    manager.attachStream("session-gate-1", "staff", "staff-stream-1");

    const validAudio = createSampleMulawAudio(160);

    // Both flags false -> Gated
    const res1 = manager.dispatchPlayback("session-gate-1", "staff", validAudio, {
      actualAudioIsolationVerified: false,
      translationPlaybackApproved: false,
    });
    expect(res1.dispatched).toBe(false);
    expect(res1.reason).toBe("PLAYBACK_GATED_ISOLATION_UNVERIFIED");
    expect(staffSocket.send).not.toHaveBeenCalled();

    // Isolation verified but translation unapproved -> Gated
    const res2 = manager.dispatchPlayback("session-gate-1", "staff", validAudio, {
      actualAudioIsolationVerified: true,
      translationPlaybackApproved: false,
    });
    expect(res2.dispatched).toBe(false);
    expect(res2.reason).toBe("PLAYBACK_GATED_ISOLATION_UNVERIFIED");
    expect(staffSocket.send).not.toHaveBeenCalled();

    // Approved but isolation unverified -> Gated
    const res3 = manager.dispatchPlayback("session-gate-1", "staff", validAudio, {
      actualAudioIsolationVerified: false,
      translationPlaybackApproved: true,
    });
    expect(res3.dispatched).toBe(false);
    expect(res3.reason).toBe("PLAYBACK_GATED_ISOLATION_UNVERIFIED");
    expect(staffSocket.send).not.toHaveBeenCalled();
  });

  it("dispatches playback strictly to the verified opposite leg when gates pass", () => {
    const manager = new LiveStreamSecurityManager();
    manager.createSession({
      sessionId: "session-gate-2",
      customerPhone: "+919087768000",
      staffPhone: "+919159267000",
    });

    const staffSocket = createMockSocket(true);
    const customerSocket = createMockSocket(true);

    manager.attachSocket("session-gate-2", "staff", staffSocket);
    manager.attachStream("session-gate-2", "staff", "staff-stream-active");

    manager.attachSocket("session-gate-2", "customer", customerSocket);
    manager.attachStream("session-gate-2", "customer", "customer-stream-active");

    const validAudio = createSampleMulawAudio(160);

    // When both gates are verified, dispatch to staff
    const dispatchStaffRes = manager.dispatchPlayback("session-gate-2", "staff", validAudio, {
      actualAudioIsolationVerified: true,
      translationPlaybackApproved: true,
    });
    expect(dispatchStaffRes.dispatched).toBe(true);
    expect(staffSocket.send).toHaveBeenCalledTimes(2); // playAudio + checkpoint
    expect(customerSocket.send).not.toHaveBeenCalled(); // Customer must not receive staff audio

    const playPayload = JSON.parse(staffSocket.send.mock.calls[0][0]);
    expect(playPayload.event).toBe("playAudio");
    expect(playPayload.streamId).toBe("staff-stream-active");
    expect(playPayload.media.contentType).toBe("audio/x-mulaw");
    expect(playPayload.media.sampleRate).toBe(8000);

    const checkpointPayload = JSON.parse(staffSocket.send.mock.calls[1][0]);
    expect(checkpointPayload.event).toBe("checkpoint");
    expect(checkpointPayload.name).toBe("tts-staff-dispatched");

    // Dispatch to customer
    const dispatchCustomerRes = manager.dispatchPlayback("session-gate-2", "customer", validAudio, {
      actualAudioIsolationVerified: true,
      translationPlaybackApproved: true,
    });
    expect(dispatchCustomerRes.dispatched).toBe(true);
    expect(customerSocket.send).toHaveBeenCalledTimes(2);
  });

  it("rejects dispatch to unready or disconnected destination streams", () => {
    const manager = new LiveStreamSecurityManager();
    manager.createSession({
      sessionId: "session-not-ready",
      customerPhone: "+919087768000",
      staffPhone: "+919159267000",
    });

    const validAudio = createSampleMulawAudio(160);

    // Staff socket not attached yet
    const unreadyRes = manager.dispatchPlayback("session-not-ready", "staff", validAudio, {
      actualAudioIsolationVerified: true,
      translationPlaybackApproved: true,
    });
    expect(unreadyRes.dispatched).toBe(false);
    expect(unreadyRes.reason).toBe("DESTINATION_STREAM_NOT_READY");

    // Staff socket closed
    const closedSocket = createMockSocket(false);
    manager.attachSocket("session-not-ready", "staff", closedSocket);
    manager.attachStream("session-not-ready", "staff", "staff-stream-closed");

    const closedRes = manager.dispatchPlayback("session-not-ready", "staff", validAudio, {
      actualAudioIsolationVerified: true,
      translationPlaybackApproved: true,
    });
    expect(closedRes.dispatched).toBe(false);
    expect(closedRes.reason).toBe("DESTINATION_SOCKET_CLOSED");
  });

  it("cleans up sockets on disconnect and closes legs on session deletion", () => {
    const manager = new LiveStreamSecurityManager();
    const session = manager.createSession({
      sessionId: "session-cleanup-1",
      customerPhone: "+919087768000",
      staffPhone: "+919159267000",
    });

    const custSocket = createMockSocket(true);
    const staffSocket = createMockSocket(true);

    manager.attachSocket("session-cleanup-1", "customer", custSocket);
    manager.attachStream("session-cleanup-1", "customer", "cust-stream");

    manager.attachSocket("session-cleanup-1", "staff", staffSocket);
    manager.attachStream("session-cleanup-1", "staff", "staff-stream");

    // Disconnect customer socket
    manager.disconnectSocket("session-cleanup-1", "customer", custSocket);
    expect(session.customerSocket).toBeUndefined();
    expect(session.customerStreamId).toBeUndefined();
    expect(session.staffSocket).toBeDefined();

    // Delete session terminates remaining legs
    manager.deleteSession("session-cleanup-1");
    expect(staffSocket.close).toHaveBeenCalledWith(1000, "Session ended");
    expect(manager.getSession("session-cleanup-1")).toBeUndefined();
  });
});

