import type { FastifyInstance } from "fastify";
import {
  createIsolatedTestSession
} from "./isolatedTestSession";

export async function registerIsolatedTestRoutes(
  app: FastifyInstance
): Promise<void> {
  app.post<{
    Body: {
      sessionId?: string;
      customerUuid?: string;
      staffUuid?: string;
    };
  }>("/dev/isolated-session", async (request, reply) => {
    const body = request.body ?? {};

    try {
      const session = createIsolatedTestSession(
        body.sessionId ?? "",
        body.customerUuid ?? "",
        body.staffUuid ?? ""
      );

      return reply.code(200).send({
        success: true,
        session
      });
    } catch {
      return reply.code(400).send({
        success: false,
        error: "Invalid simulation session identifiers"
      });
    }
  });
}
