export type CallLegRole = "customer" | "staff";

export type CallLeg = {
  callUuid: string;
  streamId: string | null;
  connected: boolean;
};

export type TwoLegSession = {
  sessionId: string;
  customer: CallLeg;
  staff: CallLeg;
  translationEnabled: boolean;
  createdAt: number;
};

export class TwoLegAudioCoordinator {
  private sessions = new Map<string, TwoLegSession>();

  create(
    sessionId: string,
    customerUuid: string,
    staffUuid: string
  ): TwoLegSession {
    if (!sessionId || !customerUuid || !staffUuid) {
      throw new Error("Missing session or call UUID");
    }

    if (customerUuid === staffUuid) {
      throw new Error("Customer and staff UUID must differ");
    }

    if (this.sessions.has(sessionId)) {
      throw new Error("Session already exists");
    }

    const session: TwoLegSession = {
      sessionId,
      customer: {
        callUuid: customerUuid,
        streamId: null,
        connected: false
      },
      staff: {
        callUuid: staffUuid,
        streamId: null,
        connected: false
      },
      translationEnabled: false,
      createdAt: Date.now()
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): TwoLegSession | undefined {
    return this.sessions.get(sessionId);
  }

  attachStream(
    sessionId: string,
    role: CallLegRole,
    streamId: string
  ): void {
    const session = this.requireSession(sessionId);

    if (!streamId) {
      throw new Error("Stream ID required");
    }

    session[role].streamId = streamId;
    session[role].connected = true;
  }

  opposite(role: CallLegRole): CallLegRole {
    return role === "customer" ? "staff" : "customer";
  }

  getDestination(
    sessionId: string,
    speaker: CallLegRole
  ): CallLeg | null {
    const session = this.requireSession(sessionId);
    const destination = session[this.opposite(speaker)];

    return destination.connected ? destination : null;
  }

  setTranslationEnabled(
    sessionId: string,
    enabled: boolean
  ): void {
    const session = this.requireSession(sessionId);

    if (enabled) {
      throw new Error(
        "Translation activation blocked until audio isolation is verified"
      );
    }

    session.translationEnabled = false;
  }

  detachStream(
    sessionId: string,
    role: CallLegRole
  ): void {
    const session = this.requireSession(sessionId);
    session[role].streamId = null;
    session[role].connected = false;
    session.translationEnabled = false;
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private requireSession(sessionId: string): TwoLegSession {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error("Unknown call session");
    }

    return session;
  }
}
