import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Workspace from "../components/Workspace";
import { verifySession,SESSION_COOKIE } from "../lib/session";
import { serverEnvironment } from "../lib/serverEnvironment";
export default async function Home() { const role = verifySession((await cookies()).get(SESSION_COOKIE)?.value,serverEnvironment()); if (!role) redirect("/login"); return <Workspace module="overview" role={role}/>; }
