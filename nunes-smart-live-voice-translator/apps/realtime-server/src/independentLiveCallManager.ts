import {
  IndependentCallSessionEngine,
  type IndependentCallSession,
  type CallLegRole,
} from "./independentCallSessionEngine.js";

import {
  IndependentCallCallbackController,
} from "./independentCallCallbackController.js";

export interface IndependentLiveCallStart {
  customerNumber: string;
  staffNumber: string;
}

export interface IndependentLiveCallRecord {
  sessionId: string;
  customerNumber: string;
  staffNumber: string;
  createdAt: number;
  state: "pending" | "connecting" | "connected" | "closed";
}

export class IndependentLiveCallManager {
  private readonly engine = new IndependentCallSessionEngine();

  private readonly callbacks =
    new IndependentCallCallbackController(this.engine);

  private readonly records =
    new Map<string, IndependentLiveCallRecord>();

  private readonly requests = new Map<string, string>();
  private readonly requestOwners = new Map<string, string>();

  constructor(private readonly maxSessions = 1000) {}

  create(input: IndependentLiveCallStart): IndependentLiveCallRecord {
    if (this.records.size >= this.maxSessions) throw new Error("SESSION_CAPACITY_EXCEEDED");
    if (!input.customerNumber?.trim()) {
      throw new Error("Customer number required");
    }

    if (!input.staffNumber?.trim()) {
      throw new Error("Staff number required");
    }

    const session = this.engine.createSession();

    const record: IndependentLiveCallRecord = {
      sessionId: session.sessionId,
      customerNumber: input.customerNumber.trim(),
      staffNumber: input.staffNumber.trim(),
      createdAt: Date.now(),
      state: "pending",
    };

    this.records.set(session.sessionId, record);

    return { ...record };
  }

  registerCall(
    sessionId: string,
    role: CallLegRole,
    callUuid: string
  ): IndependentCallSession {
    const session = this.callbacks.registerAnsweredLeg({
      sessionId,
      role,
      callUuid,
    });

    this.refreshState(sessionId, session);
    return session;
  }

  registerStream(
    sessionId: string,
    role: CallLegRole,
    callUuid: string,
    streamId: string
  ): IndependentCallSession {
    const session = this.callbacks.registerStream({
      sessionId,
      role,
      callUuid,
      streamId,
    });

    this.refreshState(sessionId, session);
    return session;
  }

  disconnectStream(
    sessionId: string,
    role: CallLegRole,
    streamId: string
  ): boolean {
    const detached = this.callbacks.handleStreamDisconnected({
      sessionId,
      role,
      streamId,
    });

    const session = this.engine.getSession(sessionId);

    if (session) {
      this.refreshState(sessionId, session);
    }

    return detached;
  }

  completeCall(
    sessionId: string,
    role: CallLegRole,
    callUuid: string
  ): boolean {
    const closed = this.callbacks.handleCallCompleted({
      sessionId,
      role,
      callUuid,
    });

    if (closed) {
      const record = this.records.get(sessionId);

      if (record) {
        record.state = "closed";
      }
    }

    return closed;
  }

  get(sessionId: string): IndependentLiveCallRecord | undefined {
    const record = this.records.get(sessionId);
    return record ? { ...record } : undefined;
  }

  getSession(sessionId: string): IndependentCallSession | undefined {
    return this.engine.getSession(sessionId);
  }

  expectRequest(sessionId: string, role: CallLegRole, requestUuid: string): void {
    const session = this.engine.getSession(sessionId);
    if (!session || session.closed || !requestUuid.trim()) throw new Error("INVALID_PROVIDER_REQUEST");
    const key = `${sessionId}:${role}`;
    const owner = this.requestOwners.get(requestUuid);
    const expected = this.requests.get(key);
    if ((owner && owner !== key) || (expected && expected !== requestUuid)) throw new Error("REQUEST_UUID_OWNERSHIP_MISMATCH");
    this.requests.set(key, requestUuid);
    this.requestOwners.set(requestUuid, key);
  }

  expectedRequest(sessionId: string, role: CallLegRole): string | undefined {
    return this.requests.get(`${sessionId}:${role}`);
  }

  assertProviderRequest(sessionId: string, role: CallLegRole, requestUuid: unknown): void {
    const expected = this.expectedRequest(sessionId, role);
    if (!expected || typeof requestUuid !== "string" || requestUuid !== expected) {
      throw new Error("REQUEST_UUID_OWNERSHIP_MISMATCH");
    }
  }

  close(sessionId: string): boolean {
    const closed = this.engine.closeSession(sessionId);
    const record = this.records.get(sessionId);
    if (record) record.state = "closed";
    return closed;
  }

  removeClosed(sessionId: string): boolean {
    if (!this.engine.removeClosedSession(sessionId)) return false;
    for (const role of ["customer", "staff"] as const) {
      const key = `${sessionId}:${role}`;
      const requestUuid = this.requests.get(key);
      if (requestUuid) this.requestOwners.delete(requestUuid);
      this.requests.delete(key);
    }
    this.records.delete(sessionId);
    return true;
  }

  allRecords(): IndependentLiveCallRecord[] {
    return [...this.records.values()].map(record => ({ ...record }));
  }

  private refreshState(
    sessionId: string,
    session: IndependentCallSession
  ): void {
    const record = this.records.get(sessionId);

    if (!record || record.state === "closed") {
      return;
    }

    if (session.closed) {
      record.state = "closed";
      return;
    }

    if (session.customer.streamId && session.staff.streamId) {
      record.state = "connected";
    } else if (session.customer.connected || session.staff.connected) {
      record.state = "connecting";
    } else {
      record.state = "pending";
    }
  }
}
