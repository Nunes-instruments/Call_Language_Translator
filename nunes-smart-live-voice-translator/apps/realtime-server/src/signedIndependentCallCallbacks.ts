import type { CallLegRole } from "./independentCallSessionEngine.js";
import type { IndependentLiveCallManager } from "./independentLiveCallManager.js";
import {
  guardPlivoWebhookRequest,
  type PlivoWebhookRequestInput,
} from "./plivoWebhookRequestGuard.js";

export interface SignedCallCallbackInput {
  webhook: PlivoWebhookRequestInput;
  sessionId: string;
  role: CallLegRole;
  callUuid: string;
}

export interface SignedStreamCallbackInput
  extends SignedCallCallbackInput {
  streamId: string;
}

export class SignedIndependentCallCallbacks {
  constructor(
    private readonly manager: IndependentLiveCallManager
  ) {}

  private authorize(input: SignedCallCallbackInput, allowClosed = false): void {
    const verification = guardPlivoWebhookRequest(input.webhook);

    if (!verification.allowed) {
      throw new Error("PLIVO_WEBHOOK_UNAUTHORIZED");
    }

    if (
      !input.sessionId ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId)
    ) {
      throw new Error("INVALID_SESSION_ID");
    }

    if (input.role !== "customer" && input.role !== "staff") {
      throw new Error("INVALID_CALL_ROLE");
    }

    if (!input.callUuid?.trim()) {
      throw new Error("INVALID_CALL_UUID");
    }

    const signedParams = input.webhook.params ?? {};

    const query = new URL(input.webhook.callbackUrl).searchParams;
    const signedSessionId = query.getAll("sessionId").length === 1 ? query.get("sessionId") : null;
    const signedRole = query.getAll("role").length === 1 ? query.get("role") : null;
    const signedCallUuid = input.webhook.method.toUpperCase() === "GET"
      ? (query.getAll("CallUUID").length === 1 ? query.get("CallUUID") : null)
      : signedParams.CallUUID;

    if (
      typeof signedSessionId !== "string" ||
      typeof signedRole !== "string" ||
      typeof signedCallUuid !== "string" ||
      signedSessionId !== input.sessionId ||
      signedRole !== input.role ||
      signedCallUuid !== input.callUuid
    ) {
      throw new Error("SIGNED_CALLBACK_IDENTITY_MISMATCH");
    }
    const session = this.manager.getSession(input.sessionId);

    if (!session || (session.closed && !allowClosed)) {
      throw new Error("SESSION_NOT_FOUND");
    }
    if (session[input.role].callUuid && session[input.role].callUuid !== input.callUuid) {
      throw new Error("CALL_UUID_OWNERSHIP_MISMATCH");
    }
    if (!this.manager.expectedRequest(input.sessionId, input.role)) throw new Error("EXPECTED_REQUEST_MISSING");
  }

  private providerParam(input: SignedCallCallbackInput, key: string): string | string[] | null | undefined {
    if (input.webhook.method.toUpperCase() !== "GET") return input.webhook.params?.[key];
    const query = new URL(input.webhook.callbackUrl).searchParams;
    return query.getAll(key).length === 1 ? query.get(key) : null;
  }

  private authorizeRequest(input: SignedCallCallbackInput): void {
    const requestUuid = this.providerParam(input, "RequestUUID");
    const aLegRequestUuid = this.providerParam(input, "ALegRequestUUID");
    if (requestUuid && aLegRequestUuid && requestUuid !== aLegRequestUuid) throw new Error("AMBIGUOUS_REQUEST_UUID");
    this.manager.assertProviderRequest(input.sessionId, input.role, requestUuid ?? aLegRequestUuid);
  }

  private signedStreamId(input: SignedStreamCallbackInput): string | string[] | null | undefined {
    if (input.webhook.method.toUpperCase() !== "GET") return input.webhook.params?.StreamID;
    const query = new URL(input.webhook.callbackUrl).searchParams;
    return query.getAll("StreamID").length === 1 ? query.get("StreamID") : null;
  }

  answered(input: SignedCallCallbackInput) {
    this.authorize(input);
    this.authorizeRequest(input);

    return this.manager.registerCall(
      input.sessionId,
      input.role,
      input.callUuid
    );
  }

  streamStarted(input: SignedStreamCallbackInput) {
    this.authorize(input);
    if (this.manager.getSession(input.sessionId)?.[input.role].callUuid !== input.callUuid) throw new Error("CALL_NOT_BOUND");

    if (this.signedStreamId(input) !== input.streamId || !input.streamId?.trim()) {
      throw new Error("INVALID_STREAM_ID");
    }

    return this.manager.registerStream(
      input.sessionId,
      input.role,
      input.callUuid,
      input.streamId
    );
  }

  streamStopped(input: SignedStreamCallbackInput): boolean {
    this.authorize(input);
    if (this.manager.getSession(input.sessionId)?.[input.role].callUuid !== input.callUuid) throw new Error("CALL_NOT_BOUND");

    if (this.signedStreamId(input) !== input.streamId || !input.streamId?.trim()) {
      throw new Error("SIGNED_STREAM_IDENTITY_MISMATCH");
    }

    return this.manager.disconnectStream(
      input.sessionId,
      input.role,
      input.streamId
    );
  }

  completed(input: SignedCallCallbackInput): boolean {
    this.authorize(input, true);
    this.authorizeRequest(input);
    const session = this.manager.getSession(input.sessionId)!;
    // A failed/unanswered outbound call may hang up before the answer callback.
    if (!session.closed && !session[input.role].callUuid) this.manager.registerCall(input.sessionId, input.role, input.callUuid);

    return this.manager.completeCall(
      input.sessionId,
      input.role,
      input.callUuid
    );
  }
}
