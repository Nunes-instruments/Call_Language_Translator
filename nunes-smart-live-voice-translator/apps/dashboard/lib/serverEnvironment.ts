import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
/** Same root server environment; values are never passed as client props or Next public env. */
export function serverEnvironment() { dotenv.config({ path:fileURLToPath(new URL("../../../.env",import.meta.url)),quiet:true }); return process.env; }
export function managementUrl(env: Record<string,string | undefined>) {
  const url = new URL(env.NUNES_MANAGEMENT_API_URL ?? "http://127.0.0.1:8787");
  if (!(["127.0.0.1","localhost","[::1]"].includes(url.hostname) && url.protocol === "http:") && url.protocol !== "https:") throw new Error("INVALID_API_ORIGIN");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("INVALID_API_ORIGIN"); return url.origin;
}
