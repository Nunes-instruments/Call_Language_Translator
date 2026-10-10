import { cookies } from "next/headers";
import { verifySession, SESSION_COOKIE } from "../../../../lib/session";
import { managementUrl, serverEnvironment } from "../../../../lib/serverEnvironment";
export const runtime = "nodejs";
async function proxy(request: Request, context: { params:Promise<{ path:string[] }> }) {
  const env = serverEnvironment(), role = verifySession((await cookies()).get(SESSION_COOKIE)?.value,env);
  if (!role) return Response.json({ error:"UNAUTHORIZED" },{ status:401 });
  if (request.method !== "GET" && (role !== "ADMIN" || request.headers.get("origin") !== new URL(request.url).origin)) return Response.json({ error:"FORBIDDEN" },{ status:403 });
  const { path } = await context.params;
  if (!path.length || path.length > 3 || path.some(part => !/^[a-zA-Z0-9-]+$/.test(part)) || !["overview","identity","employees","glossary","calls","settings","retention","audit","diagnostics","providers","pilot"].includes(path[0])) return Response.json({ error:"NOT_FOUND" },{ status:404 });
  try {
    const body = request.method === "GET" ? undefined : await request.text(); if (body && body.length > 32768) return Response.json({ error:"BODY_TOO_LARGE" },{ status:413 });
    const credential = role === "ADMIN" ? env.NUNES_ADMIN_PASSWORD : env.NUNES_VIEWER_PASSWORD;
    const response = await fetch(`${managementUrl(env)}/management/${path.join("/")}${new URL(request.url).search}`,{ method:request.method,headers:{ authorization:`Bearer ${credential}`,"content-type":"application/json" },body,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(5000) });
    return new Response(await response.text(),{ status:response.status,headers:{ "content-type":"application/json","Cache-Control":"no-store" } });
  } catch { return Response.json({ error:"SERVER_UNAVAILABLE" },{ status:503 }); }
}
export { proxy as GET,proxy as POST,proxy as PUT,proxy as DELETE };
