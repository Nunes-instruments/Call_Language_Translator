import { Client } from "plivo";

let liveCallsApproved: boolean = process.env.NUNES_INDEPENDENT_LIVE_CALLS_APPROVED === "true";

export function setIndependentLiveCallsApproved(approved: boolean) {
  liveCallsApproved = approved;
}

export function isIndependentLiveCallsApproved(): boolean {
  return liveCallsApproved;
}

// Reversible operator approval sentinel
export const INDEPENDENT_LIVE_CALLS_APPROVED = false as const;

export interface IndependentPlivoCallInput {
  authId: string;
  authToken: string;
  from: string;
  to: string;
  answerUrl: string;
  hangupUrl?: string;
}

export interface IndependentPlivoCallResult {
  requestUuid: string;
  message: string;
}

/**
 * Creates a separate outbound Plivo call.
 *
 * This module does not connect customer and staff together.
 * It does not activate translation or bypass audio isolation.
 *
 * Calling this function makes a real billable phone call.
 * Do not invoke until explicit live-call approval.
 */
export async function createIndependentPlivoCall(
  input: IndependentPlivoCallInput
): Promise<IndependentPlivoCallResult> {
  if (!INDEPENDENT_LIVE_CALLS_APPROVED && !liveCallsApproved) throw new Error("LIVE_CALL_APPROVAL_REQUIRED");
  if (
    !input.authId.trim() ||
    !input.authToken.trim() ||
    !input.from.trim() ||
    !input.to.trim()
  ) {
    throw new Error("Missing Plivo call configuration");
  }

  const answerUrl = new URL(input.answerUrl);

  if (
    answerUrl.protocol !== "https:" ||
    answerUrl.username ||
    answerUrl.password ||
    answerUrl.hash
  ) {
    throw new Error("Invalid Plivo answer URL");
  }

  if (input.hangupUrl) {
    const hangupUrl = new URL(input.hangupUrl);

    if (
      hangupUrl.protocol !== "https:" ||
      hangupUrl.username ||
      hangupUrl.password ||
      hangupUrl.hash
    ) {
      throw new Error("Invalid Plivo hangup URL");
    }
  }

  const client = new Client(
    input.authId,
    input.authToken
  );

  const response = await client.calls.create(
    input.from,
    input.to,
    input.answerUrl,
    {
      answerMethod: "POST",
      ringTimeout: 120,
      timeLimit: 1800,
      ...(input.hangupUrl
        ? {
            hangupUrl: input.hangupUrl,
            hangupMethod: "POST",
          }
        : {}),
    }
  );

  return {
    requestUuid: String(
      response.requestUuid ?? ""
    ),
    message: String(
      response.message ?? ""
    ),
  };
}
