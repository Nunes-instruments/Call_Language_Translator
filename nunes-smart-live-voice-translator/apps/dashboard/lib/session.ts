import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
export type DashboardRole = "ADMIN" | "VIEWER";
export const SESSION_COOKIE = "nunes_session";
export function sessionKey(env: Record<string,string | undefined>) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32 || env.AUTH_SECRET.includes("replace-with")) throw new Error("SESSION_AUTH_UNAVAILABLE");
  return env.AUTH_SECRET;
}
export function createSession(role: DashboardRole, env: Record<string,string | undefined>, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ role,expires:now+8*60*60*1000,nonce:randomBytes(16).toString("hex") })).toString("base64url");
  const credential = role === "ADMIN" ? env.NUNES_ADMIN_PASSWORD : env.NUNES_VIEWER_PASSWORD;
  if (!credential) throw new Error("AUTH_UNAVAILABLE");
  return `${payload}.${createHmac("sha256",sessionKey(env)).update(payload + credential).digest("base64url")}`;
}
export function verifySession(token: string | undefined, env: Record<string,string | undefined>, now = Date.now()): DashboardRole | undefined {
  try {
    if (!token || token.length > 1000) return;
    const [payload,signature,...extra] = token.split("."); if (extra.length || !payload || !signature) return;
    const value = JSON.parse(Buffer.from(payload,"base64url").toString()) as { role: DashboardRole; expires: number };
    if (!["ADMIN","VIEWER"].includes(value.role) || !Number.isFinite(value.expires) || value.expires <= now || value.expires > now+8*60*60*1000) return;
    const credential = value.role === "ADMIN" ? env.NUNES_ADMIN_PASSWORD : env.NUNES_VIEWER_PASSWORD; if (!credential) return;
    const expected = createHmac("sha256",sessionKey(env)).update(payload+credential).digest("base64url");
    if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected),Buffer.from(signature))) return;
    return value.role;
  } catch { return; }
}
