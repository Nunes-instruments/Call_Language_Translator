import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  registerIsolatedTestRoutes
} from "./isolatedTestRoutes";

describe("Isolated test API", () => {
  it("creates a simulation session", async () => {
    const app = Fastify();

    try {
      await app.register(registerIsolatedTestRoutes);

      const response = await app.inject({
        method: "POST",
        url: "/dev/isolated-session",
        payload: {
          sessionId: "test-1",
          customerUuid: "customer-1",
          staffUuid: "staff-1"
        }
      });

      expect(response.statusCode).toBe(200);

      const body = response.json();

      expect(body.session.mode).toBe("simulation");
      expect(body.session.translationEnabled).toBe(false);
      expect(body.session.audioIsolationVerified).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("rejects identical call legs", async () => {
    const app = Fastify();

    try {
      await app.register(registerIsolatedTestRoutes);

      const response = await app.inject({
        method: "POST",
        url: "/dev/isolated-session",
        payload: {
          sessionId: "test-2",
          customerUuid: "same",
          staffUuid: "same"
        }
      });

      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects missing identifiers", async () => {
    const app = Fastify();

    try {
      await app.register(registerIsolatedTestRoutes);

      const response = await app.inject({
        method: "POST",
        url: "/dev/isolated-session",
        payload: {}
      });

      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("does not register production call routes", async () => {
    const app = Fastify();

    try {
      await app.register(registerIsolatedTestRoutes);

      const response = await app.inject({
        method: "POST",
        url: "/plivo/inbound"
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
