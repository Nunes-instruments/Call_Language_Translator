export type IsolatedLeg = "customer" | "staff";

export function buildIsolatedMediaXml(
  leg: IsolatedLeg,
  websocketUrl: string
): string {
  if (leg !== "customer" && leg !== "staff") {
    throw new Error("Invalid call leg");
  }

  if (!websocketUrl.startsWith("wss://")) {
    throw new Error("Secure WebSocket URL required");
  }

  const url = new URL(websocketUrl);

  if (url.protocol !== "wss:") {
    throw new Error("Invalid WebSocket protocol");
  }

  url.searchParams.set("leg", leg);

  const escapeXml = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true"
          audioTrack="inbound"
          contentType="audio/x-mulaw;rate=8000"
          keepCallAlive="true">${escapeXml(url.toString())}</Stream>
</Response>`;
}
