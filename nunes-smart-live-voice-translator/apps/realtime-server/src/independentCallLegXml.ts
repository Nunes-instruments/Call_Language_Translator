export type IndependentLegRole = "customer" | "staff";

export interface IndependentLegXmlInput {
  role: IndependentLegRole;
  publicBaseUrl: string;
  sessionId: string;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Generates independent Plivo media-stream XML.
 *
 * IMPORTANT:
 * - Does not bridge customer and staff directly.
 * - Does not activate live translation.
 * - Does not establish that audio isolation is verified.
 * - Must not be deployed without Plivo media validation.
 */
export function buildIndependentCallLegXml(
  input: IndependentLegXmlInput
): string {
  const base = new URL(input.publicBaseUrl);

  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.hash ||
    base.search
  ) {
    throw new Error("Invalid public base URL");
  }

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId)) {
    throw new Error("Invalid session ID");
  }

  if (input.role !== "customer" && input.role !== "staff") {
    throw new Error("Invalid call-leg role");
  }

  const streamUrl = new URL(
    "/plivo/stream",
    base
  );

  streamUrl.protocol = "wss:";
  streamUrl.searchParams.set("sessionId", input.sessionId);
  streamUrl.searchParams.set("role", input.role);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Stream bidirectional="true" keepCallAlive="true" audioTrack="inbound" contentType="audio/x-mulaw;rate=8000">${escapeXml(streamUrl.toString())}</Stream>`,
    "</Response>",
  ].join("\n");
}