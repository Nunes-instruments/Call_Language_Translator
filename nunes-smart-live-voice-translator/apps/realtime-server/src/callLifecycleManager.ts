import { TwoLegAudioCoordinator } from "./twoLegAudioCoordinator";

export type DialLegEvent = {
  sessionId: string;
  customerUuid: string;
  staffUuid: string;
  status: string;
};

export class CallLifecycleManager {
  private readonly coordinator = new TwoLegAudioCoordinator();

  private readonly completed = new Set<string>();

  register(event: DialLegEvent): boolean {
    const {
      sessionId,
      customerUuid,
      staffUuid,
      status
    } = event;

    if (!sessionId || !customerUuid || !staffUuid) {
      return false;
    }

    if (this.completed.has(sessionId)) {
      return false;
    }

    if (status.toLowerCase() !== "connected") {
      return false;
    }

    if (this.coordinator.get(sessionId)) {
      return false;
    }

    this.coordinator.create(
      sessionId,
      customerUuid,
      staffUuid
    );

    return true;
  }

  get(sessionId: string) {
    return this.coordinator.get(sessionId);
  }

  complete(sessionId: string): void {
    this.coordinator.remove(sessionId);
    this.completed.add(sessionId);
  }

  isCompleted(sessionId: string): boolean {
    return this.completed.has(sessionId);
  }
}
