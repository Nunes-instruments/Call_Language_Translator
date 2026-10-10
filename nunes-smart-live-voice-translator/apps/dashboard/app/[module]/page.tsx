import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import Workspace, { type Module } from "../../components/Workspace";
import { verifySession, SESSION_COOKIE } from "../../lib/session";
import { serverEnvironment } from "../../lib/serverEnvironment";
const allowed = ["live-calls","call-history","employees","language-settings","technical-glossary","providers","diagnostics","security-audit","settings","pilot-authorization","emergency-stop"];
export default async function ModulePage({ params }: { params:Promise<{module:string}> }) { const {module} = await params; if(!allowed.includes(module))notFound(); const role=verifySession((await cookies()).get(SESSION_COOKIE)?.value,serverEnvironment()); if(!role)redirect("/login"); return <Workspace key={module} module={module as Module} role={role}/>; }
