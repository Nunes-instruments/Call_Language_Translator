import {
  IndependentCallSessionEngine,
  type CallLegRole,
  type IndependentCallSession,
} from "./independentCallSessionEngine.js";

export interface IndependentCallCallback {
  sessionId: string;
  role: CallLegRole;
  callUuid: string;
}

export interface IndependentStreamCallback
  extends IndependentCallCallback {
  streamId: string;
}

/**
 * Coordinates independent customer and staff call legs.
 *
 * This controller does not accept unauthenticated HTTP
 * callbacks directly. Production routes must verify Plivo
 * signatures and session authorization before invoking it.
 */
export class IndependentCallCallbackController {
  constructor(
    private readonly engine: IndependentCallSessionEngine
  ) {}

  registerAnsweredLeg(
    input: IndependentCallCallback
  ): IndependentCallSession {
    return this.engine.attachCall(
      input.sessionId,
      input.role,
      input.callUuid
    );
  }

  registerStream(
    input: IndependentStreamCallback
  ): IndependentCallSession {
    return this.engine.attachStream(
      input.sessionId,
      input.role,
      input.callUuid,
      input.streamId
    );
  }

  handleStreamDisconnected(
    input: Pick<
      IndependentStreamCallback,
      "sessionId" | "role" | "streamId"
    >
  ): boolean {
    return this.engine.detachStream(
      input.sessionId,
      input.role,
      input.streamId
    );
  }

  handleCallCompleted(
    input: IndependentCallCallback
  ): boolean {
    const session = this.engine.getSession(
      input.sessionId
    );

    if (
      !session ||
      session.closed ||
      session[input.role].callUuid !== input.callUuid
    ) {
      return false;
    }

    return this.engine.closeSession(
      input.sessionId
    );
  }

  getSession(
    sessionId: string
  ): IndependentCallSession | undefined {
    return this.engine.getSession(sessionId);
  }
}