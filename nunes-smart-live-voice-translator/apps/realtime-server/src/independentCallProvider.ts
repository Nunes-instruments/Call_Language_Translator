import { randomUUID } from "node:crypto";
import { Client } from "plivo";
import { createIndependentPlivoCall, INDEPENDENT_LIVE_CALLS_APPROVED, isIndependentLiveCallsApproved, type IndependentPlivoCallResult } from "./independentPlivoCallCreator.js";
import type { CallLegRole } from "./independentCallSessionEngine.js";

export interface IndependentProviderLeg {
  sessionId: string;
  role: CallLegRole;
  from: string;
  to: string;
  answerUrl: string;
  hangupUrl: string;
}

export interface IndependentCallProvider {
  readonly mode: "offline" | "live";
  createLeg(input: IndependentProviderLeg): Promise<IndependentPlivoCallResult>;
  stopLeg(input: { requestUuid: string; callUuid: string | null }): Promise<void>;
}

/** Explicit test adapter: no SDK clients, sockets, or HTTP requests. Bounded diagnostics. */
export class OfflineIndependentCallProvider implements IndependentCallProvider {
  readonly mode = "offline" as const;
  readonly created: Array<IndependentProviderLeg & { requestUuid: string }> = [];
  readonly stopped: Array<{ requestUuid: string; callUuid: string | null }> = [];
  failRole?: CallLegRole;
  failCleanup = false;

  async createLeg(input: IndependentProviderLeg): Promise<IndependentPlivoCallResult> {
    if (input.role === this.failRole) throw new Error("OFFLINE_PROVIDER_FAILURE");
    const requestUuid = randomUUID();
    this.created.push({ ...input, requestUuid });
    if (this.created.length > 1000) this.created.shift();
    return { requestUuid, message: "offline call simulated" };
  }

  async stopLeg(input: { requestUuid: string; callUuid: string | null }): Promise<void> {
    if (this.failCleanup) throw new Error("OFFLINE_CLEANUP_FAILURE");
    this.stopped.push({ ...input });
    if (this.stopped.length > 1000) this.stopped.shift();
  }
}

/** The separate production approval gate is deliberately locked for Phase 2. */
export { INDEPENDENT_LIVE_CALLS_APPROVED };

export class PlivoIndependentCallProvider implements IndependentCallProvider {
  readonly mode = "live" as const;
  constructor(private readonly config: { authId: string; authToken: string }) {}
  async createLeg(input: IndependentProviderLeg): Promise<IndependentPlivoCallResult> {
    if (!INDEPENDENT_LIVE_CALLS_APPROVED && !isIndependentLiveCallsApproved()) throw new Error("LIVE_CALL_APPROVAL_REQUIRED");
    return createIndependentPlivoCall({ ...this.config, ...input });
  }
  async stopLeg(input: { requestUuid: string; callUuid: string | null }): Promise<void> {
    if (!INDEPENDENT_LIVE_CALLS_APPROVED && !isIndependentLiveCallsApproved()) throw new Error("LIVE_CALL_APPROVAL_REQUIRED");
    const client = new Client(this.config.authId, this.config.authToken);
    if (input.callUuid) await client.calls.hangup(input.callUuid);
    else await client.calls.cancel(input.requestUuid);
  }
}
