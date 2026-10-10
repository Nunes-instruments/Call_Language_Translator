import { cookies } from "next/headers";
import { createSession, sessionKey, SESSION_COOKIE } from "../../../lib/session";
import { managementUrl, serverEnvironment } from "../../../lib/serverEnvironment";
export const runtime = "nodejs";
const attempts = new Map<string,{ count:number; since:number }>();
function sameOrigin(request: Request) { return request.headers.get("origin") === new URL(request.url).origin; }
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error:"INVALID_ORIGIN" },{ status:403 });
  const timestamp = Date.now(); for (const [key,value] of attempts) if (timestamp-value.since >= 60000) attempts.delete(key);
  // No proxy header trust: a global bound is conservative across deployments.
  const limit = attempts.get("login") ?? { count:0,since:timestamp }; attempts.set("login",limit);
  if (++limit.count > 20) return Response.json({ error:"RATE_LIMITED" },{ status:429 });
  try {
    if (Number(request.headers.get("content-length")) > 4096) return Response.json({ error:"INVALID_LOGIN" },{ status:400 });
    const text = await request.text(); if (text.length > 4096) return Response.json({ error:"INVALID_LOGIN" },{ status:400 });
    const body = JSON.parse(text) as { password?:unknown };
    if (typeof body.password !== "string" || body.password.length > 512) return Response.json({ error:"INVALID_LOGIN" },{ status:400 });
    const env = serverEnvironment(); sessionKey(env);
    const response = await fetch(`${managementUrl(env)}/management/identity`,{ headers:{ authorization:`Bearer ${body.password}` },cache:"no-store",signal:AbortSignal.timeout(5000),redirect:"error" });
    if (!response.ok) return Response.json({ error:response.status === 401 ? "INVALID_CREDENTIALS" : "AUTH_UNAVAILABLE" },{ status:response.status === 401 ? 401:503 });
    const actor = await response.json() as { role:"ADMIN" | "VIEWER" };
    if (!["ADMIN","VIEWER"].includes(actor.role)) throw new Error("INVALID_ROLE");
    (await cookies()).set(SESSION_COOKIE,createSession(actor.role,env),{ httpOnly:true,sameSite:"strict",secure:process.env.NODE_ENV === "production",path:"/",maxAge:8*60*60 });
    return Response.json({ role:actor.role },{ headers:{ "Cache-Control":"no-store" } });
  } catch { return Response.json({ error:"AUTH_UNAVAILABLE" },{ status:503 }); }
}
export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error:"INVALID_ORIGIN" },{ status:403 });
  (await cookies()).delete(SESSION_COOKIE); return Response.json({ loggedOut:true });
}
