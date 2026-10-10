import type { CallLegRole } from "./independentCallSessionEngine.js";

export interface IndependentCallLegUrls {
  answerUrl: string;
  streamStartedUrl: string;
  streamStoppedUrl: string;
  completedUrl: string;
  streamStatusUrl: string;
}

export function buildIndependentCallLegUrls(
  publicBaseUrl: string,
  sessionId: string,
  role: CallLegRole
): IndependentCallLegUrls {
  const base = new URL(publicBaseUrl);

  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error("INVALID_PUBLIC_BASE_URL");
  }

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
    throw new Error("INVALID_SESSION_ID");
  }

  if (role !== "customer" && role !== "staff") {
    throw new Error("INVALID_ROLE");
  }

  const makeUrl = (path: string): string => {
    const url = new URL(path, base);
    url.searchParams.set("sessionId", sessionId);
    url.searchParams.set("role", role);
    return url.toString();
  };

  return {
    answerUrl: makeUrl("/plivo/independent/answered"),
    streamStartedUrl: makeUrl("/plivo/independent/stream-started"),
    streamStoppedUrl: makeUrl("/plivo/independent/stream-stopped"),
    completedUrl: makeUrl("/plivo/independent/completed"),
    streamStatusUrl: makeUrl("/plivo/independent/stream-status"),
  };
}
