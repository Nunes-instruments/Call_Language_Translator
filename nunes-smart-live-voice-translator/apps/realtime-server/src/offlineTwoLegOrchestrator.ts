import {
  TwoLegAudioCoordinator,
  type CallLegRole
} from "./twoLegAudioCoordinator";
import { buildIsolatedMediaXml } from "./isolatedMediaXml";

export class OfflineTwoLegOrchestrator {
  private readonly coordinator = new TwoLegAudioCoordinator();

  create(
    sessionId: string,
    customerUuid: string,
    staffUuid: string,
    websocketUrl: string
  ) {
    if (!websocketUrl.startsWith("wss://")) {
      throw new Error("Secure WebSocket URL required");
    }

    const customerXml = buildIsolatedMediaXml(
      "customer",
      websocketUrl
    );

    const staffXml = buildIsolatedMediaXml(
      "staff",
      websocketUrl
    );

    const session = this.coordinator.create(
      sessionId,
      customerUuid,
      staffUuid
    );

    return {
      session,
      customerXml,
      staffXml,
      mode: "simulation" as const,
      audioIsolationVerified: false as const,
      translationEnabled: false as const
    };
  }

  attach(
    sessionId: string,
    role: CallLegRole,
    streamId: string
  ) {
    this.coordinator.attachStream(sessionId, role, streamId);
    return this.coordinator.get(sessionId);
  }

  detach(sessionId: string, role: CallLegRole) {
    this.coordinator.detachStream(sessionId, role);
    return this.coordinator.get(sessionId);
  }

  get(sessionId: string) {
    return this.coordinator.get(sessionId);
  }

  activateTranslation(sessionId: string): never {
    this.coordinator.setTranslationEnabled(sessionId, true);
    throw new Error("Translation activation blocked");
  }

  complete(sessionId: string): void {
    this.coordinator.remove(sessionId);
  }
}
