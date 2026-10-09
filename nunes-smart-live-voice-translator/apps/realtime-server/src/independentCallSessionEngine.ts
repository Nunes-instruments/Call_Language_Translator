import { randomUUID } from "node:crypto";

export type CallLegRole = "customer" | "staff";

export type CallLegState = {
  role: CallLegRole;
  callUuid: string | null;
  streamId: string | null;
  connected: boolean;
};

export type IndependentCallSession = {
  sessionId: string;
  customer: CallLegState;
  staff: CallLegState;
  closed: boolean;
  translationEnabled: false;
};

export class IndependentCallSessionEngine {
  private readonly sessions =
    new Map<string, IndependentCallSession>();

  private readonly callOwners = new Map<string, string>();
  private readonly streamOwners = new Map<string, string>();

  createSession(): IndependentCallSession {
    const sessionId = randomUUID();

    const session: IndependentCallSession = {
      sessionId,
      customer: {
        role: "customer",
        callUuid: null,
        streamId: null,
        connected: false,
      },
      staff: {
        role: "staff",
        callUuid: null,
        streamId: null,
        connected: false,
      },
      closed: false,
      translationEnabled: false,
    };

    this.sessions.set(sessionId, session);
    return this.snapshot(session);
  }

  getSession(sessionId: string):
    IndependentCallSession | undefined {
    const session = this.sessions.get(sessionId);
    return session ? this.snapshot(session) : undefined;
  }

  attachCall(
    sessionId: string,
    role: CallLegRole,
    callUuid: string
  ): IndependentCallSession {
    const session = this.requireOpen(sessionId);
    const leg = session[role];

    if (!callUuid.trim()) {
      throw new Error("Missing call UUID");
    }

    const owner = this.callOwners.get(callUuid);

    if (owner && owner !== `${sessionId}:${role}`) {
      throw new Error("Call UUID belongs to another leg");
    }

    if (leg.callUuid && leg.callUuid !== callUuid) {
      throw new Error("Call leg already has a different UUID");
    }

    leg.callUuid = callUuid;
    leg.connected = true;
    this.callOwners.set(callUuid, `${sessionId}:${role}`);

    return this.snapshot(session);
  }

  attachStream(
    sessionId: string,
    role: CallLegRole,
    callUuid: string,
    streamId: string
  ): IndependentCallSession {
    const session = this.requireOpen(sessionId);
    const leg = session[role];

    if (
      !streamId.trim() ||
      !leg.connected ||
      leg.callUuid !== callUuid
    ) {
      throw new Error("Invalid stream attachment");
    }

    const owner = this.streamOwners.get(streamId);

    if (owner && owner !== `${sessionId}:${role}`) {
      throw new Error("Stream belongs to another leg");
    }

    if (leg.streamId && leg.streamId !== streamId) {
      throw new Error("Call leg already has another stream");
    }

    leg.streamId = streamId;
    this.streamOwners.set(streamId, `${sessionId}:${role}`);

    return this.snapshot(session);
  }

  detachStream(
    sessionId: string,
    role: CallLegRole,
    streamId: string
  ): boolean {
    const session = this.sessions.get(sessionId);

    if (!session || session.closed) return false;

    const leg = session[role];

    if (leg.streamId !== streamId) return false;

    leg.streamId = null;
    this.streamOwners.delete(streamId);

    return true;
  }

  closeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);

    if (!session || session.closed) return false;

    for (const role of ["customer", "staff"] as const) {
      const leg = session[role];

      if (leg.callUuid) {
        this.callOwners.delete(leg.callUuid);
      }

      if (leg.streamId) {
        this.streamOwners.delete(leg.streamId);
      }

      leg.connected = false;
      leg.streamId = null;
    }

    session.closed = true;
    return true;
  }

  enableTranslation(): never {
    throw new Error(
      "Live translation blocked: Plivo audio isolation unverified"
    );
  }

  private requireOpen(
    sessionId: string
  ): IndependentCallSession {
    const session = this.sessions.get(sessionId);

    if (!session || session.closed) {
      throw new Error("Unknown or closed call session");
    }

    return session;
  }

  private snapshot(
    session: IndependentCallSession
  ): IndependentCallSession {
    return {
      ...session,
      customer: { ...session.customer },
      staff: { ...session.staff },
    };
  }
}