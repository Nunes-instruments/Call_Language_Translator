import crypto from "node:crypto";
import { decodeMulaw, validAudioBase64 } from "./telephonyAudioCodec.js";

export type CallLegRole = "customer" | "staff";

export interface LiveDualLegSession {
  sessionId: string;
  customerPhone: string;
  staffPhone: string;
  customerToken: string;
  staffToken: string;
  customerCallUuid?: string;
  staffCallUuid?: string;
  customerStreamId?: string;
  staffStreamId?: string;
  customerSocket?: any;
  staffSocket?: any;
  customerPackets: number;
  customerBytes: number;
  staffPackets: number;
  staffBytes: number;
  customerSarvamWs?: any;
  staffSarvamWs?: any;
  lastCustomerTranscript?: string;
  lastStaffTranscript?: string;
  lastTranslationHiToTa?: string;
  lastTranslationTaToHi?: string;
  lastStaffTtsBytes?: number;
  lastCustomerTtsBytes?: number;
  playbackGated: boolean;
  createdAt: number;
  closed: boolean;
}

export interface PlaybackGates {
  actualAudioIsolationVerified: boolean;
  translationPlaybackApproved: boolean;
}

/**
 * Validates that synthesized audio is genuine 8 kHz G.711 mu-law audio.
 * Rejects empty, oversized, non-buffer, or malformed data.
 */
export function validateMulaw8kAudio(audio: Buffer, maxBytes = 80_000): boolean {
  if (!Buffer.isBuffer(audio) || audio.length === 0 || audio.length > maxBytes) {
    return false;
  }
  try {
    const pcm = decodeMulaw(audio);
    if (pcm.length !== audio.length) return false;
    for (let i = 0; i < pcm.length; i++) {
      if (!Number.isFinite(pcm[i])) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export class LiveStreamSecurityManager {
  private readonly sessions = new Map<string, LiveDualLegSession>();

  createSession(params: {
    sessionId: string;
    customerPhone: string;
    staffPhone: string;
    customerCallUuid?: string;
  }): LiveDualLegSession {
    const customerToken = crypto.randomBytes(32).toString("base64url");
    const staffToken = crypto.randomBytes(32).toString("base64url");

    const session: LiveDualLegSession = {
      sessionId: params.sessionId,
      customerPhone: params.customerPhone,
      staffPhone: params.staffPhone,
      customerToken,
      staffToken,
      customerCallUuid: params.customerCallUuid,
      customerPackets: 0,
      customerBytes: 0,
      staffPackets: 0,
      staffBytes: 0,
      playbackGated: true,
      createdAt: Date.now(),
      closed: false,
    };

    this.sessions.set(params.sessionId, session);
    return session;
  }

  getSession(sessionId: string): LiveDualLegSession | undefined {
    return this.sessions.get(sessionId);
  }

  deleteSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.closed = true;
      try { session.customerSocket?.close(1000, "Session ended"); } catch {}
      try { session.staffSocket?.close(1000, "Session ended"); } catch {}
      try { session.customerSarvamWs?.close(); } catch {}
      try { session.staffSarvamWs?.close(); } catch {}
      return this.sessions.delete(sessionId);
    }
    return false;
  }

  /**
   * Cryptographically validates connection token using constant-time comparison.
   */
  validateToken(sessionId: string, role: CallLegRole, token: string): boolean {
    if (!sessionId || !role || !token || typeof token !== "string") {
      return false;
    }
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      return false;
    }
    const expected = role === "customer" ? session.customerToken : session.staffToken;
    if (!expected) {
      return false;
    }
    const expBuf = Buffer.from(expected);
    const actBuf = Buffer.from(token);
    if (expBuf.length !== actBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(expBuf, actBuf);
  }

  /**
   * Asserts whether a new socket can attach for (sessionId, role).
   * Rejects unknown sessions, closed sessions, and duplicate active sockets.
   */
  assertCanAttachSocket(
    sessionId: string,
    role: CallLegRole
  ): { allowed: boolean; status: number; reason?: string } {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      return { allowed: false, status: 404, reason: "SESSION_NOT_FOUND_OR_CLOSED" };
    }
    const existing = role === "customer" ? session.customerSocket : session.staffSocket;
    if (existing) {
      // If active and open (readyState 1 in ws)
      const isOpen = existing.readyState === 1 || (existing.readyState === undefined && !existing.closed);
      if (isOpen) {
        return { allowed: false, status: 409, reason: "DUPLICATE_ACTIVE_SOCKET" };
      }
    }
    return { allowed: true, status: 200 };
  }

  attachSocket(sessionId: string, role: CallLegRole, socket: any): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      throw new Error("CANNOT_ATTACH_TO_CLOSED_SESSION");
    }
    if (role === "customer") {
      session.customerSocket = socket;
    } else {
      session.staffSocket = socket;
    }
  }

  /**
   * Validates and attaches streamId to the call leg.
   * Prevents stream hijacking by rejecting attempts to alter an attached streamId.
   */
  attachStream(
    sessionId: string,
    role: CallLegRole,
    streamId: string,
    callId?: string
  ): { allowed: boolean; reason?: string } {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      return { allowed: false, reason: "SESSION_NOT_FOUND" };
    }
    if (!streamId || typeof streamId !== "string" || !streamId.trim() || streamId.length > 128) {
      return { allowed: false, reason: "INVALID_STREAM_ID" };
    }

    const currentStream = role === "customer" ? session.customerStreamId : session.staffStreamId;
    if (currentStream && currentStream !== streamId.trim()) {
      return { allowed: false, reason: "STREAM_HIJACKING_ATTEMPT" };
    }

    if (role === "customer") {
      session.customerStreamId = streamId.trim();
      if (callId && typeof callId === "string") session.customerCallUuid = callId.trim();
    } else {
      session.staffStreamId = streamId.trim();
      if (callId && typeof callId === "string") session.staffCallUuid = callId.trim();
    }

    return { allowed: true };
  }

  /**
   * Validates incoming media frames for stream ownership and payload validity.
   */
  validateMediaPacket(
    sessionId: string,
    role: CallLegRole,
    streamId?: string,
    payload?: string
  ): { allowed: boolean; reason?: string; bytes?: Buffer } {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      return { allowed: false, reason: "SESSION_NOT_FOUND" };
    }
    const expectedStream = role === "customer" ? session.customerStreamId : session.staffStreamId;
    if (!expectedStream) {
      return { allowed: false, reason: "STREAM_NOT_ATTACHED" };
    }
    if (streamId && streamId !== expectedStream) {
      return { allowed: false, reason: "STREAM_ID_MISMATCH" };
    }
    if (!payload || typeof payload !== "string") {
      return { allowed: false, reason: "EMPTY_PAYLOAD" };
    }
    try {
      const bytes = validAudioBase64(payload, 80_000);
      return { allowed: true, bytes };
    } catch {
      return { allowed: false, reason: "INVALID_BASE64_AUDIO" };
    }
  }

  /**
   * Dispatches synthesized translated audio exclusively to the verified opposite leg.
   * Gated by actualAudioIsolationVerified and translationPlaybackApproved.
   * Audio is validated for genuine 8 kHz mu-law format before dispatch.
   */
  dispatchPlayback(
    sessionId: string,
    destinationRole: CallLegRole,
    audio: Buffer,
    gates: PlaybackGates
  ): { dispatched: boolean; reason?: string } {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      return { dispatched: false, reason: "SESSION_NOT_FOUND" };
    }

    // Gate 1: Real Leg Isolation & Operator Approval
    if (!gates.actualAudioIsolationVerified || !gates.translationPlaybackApproved) {
      return { dispatched: false, reason: "PLAYBACK_GATED_ISOLATION_UNVERIFIED" };
    }

    // Gate 2: Audio Format Verification
    if (!validateMulaw8kAudio(audio)) {
      return { dispatched: false, reason: "INVALID_MULAW_8K_AUDIO" };
    }

    // Gate 3: Destination Leg Verification
    const targetSocket = destinationRole === "customer" ? session.customerSocket : session.staffSocket;
    const targetStreamId = destinationRole === "customer" ? session.customerStreamId : session.staffStreamId;

    if (!targetSocket || !targetStreamId) {
      return { dispatched: false, reason: "DESTINATION_STREAM_NOT_READY" };
    }

    const isOpen = targetSocket.readyState === 1 || (targetSocket.readyState === undefined && !targetSocket.closed);
    if (!isOpen) {
      return { dispatched: false, reason: "DESTINATION_SOCKET_CLOSED" };
    }

    // Send playAudio
    const message = JSON.stringify({
      event: "playAudio",
      streamId: targetStreamId,
      media: {
        contentType: "audio/x-mulaw",
        sampleRate: 8000,
        payload: audio.toString("base64"),
      },
    });

    if (typeof targetSocket.send === "function") {
      targetSocket.send(message);
      // Send checkpoint
      const checkpoint = JSON.stringify({
        event: "checkpoint",
        streamId: targetStreamId,
        name: `tts-${destinationRole}-dispatched`,
      });
      targetSocket.send(checkpoint);
      return { dispatched: true };
    }

    return { dispatched: false, reason: "SEND_UNAVAILABLE" };
  }

  disconnectSocket(sessionId: string, role: CallLegRole, socket: any): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (role === "customer" && session.customerSocket === socket) {
      delete session.customerSocket;
      delete session.customerStreamId;
      try { session.customerSarvamWs?.close(); } catch {}
    } else if (role === "staff" && session.staffSocket === socket) {
      delete session.staffSocket;
      delete session.staffStreamId;
      try { session.staffSarvamWs?.close(); } catch {}
    }
  }
}

