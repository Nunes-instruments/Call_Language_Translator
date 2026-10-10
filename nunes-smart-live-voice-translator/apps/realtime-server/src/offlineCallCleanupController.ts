import {
  TwoLegAudioCoordinator,
  type CallLegRole
} from "./twoLegAudioCoordinator";
import {
  CrossLegAudioDispatcher,
  type AudioSocket
} from "./crossLegAudioDispatcher";

export class OfflineCallCleanupController {
  readonly coordinator = new TwoLegAudioCoordinator();
  readonly dispatcher = new CrossLegAudioDispatcher(this.coordinator);
  private readonly socketOwners = new Map<string, AudioSocket>();

  create(
    sessionId: string,
    customerUuid: string,
    staffUuid: string
  ) {
    return this.coordinator.create(
      sessionId,
      customerUuid,
      staffUuid
    );
  }

  attach(
    sessionId: string,
    role: CallLegRole,
    streamId: string,
    socket: AudioSocket
  ): void {
    this.coordinator.attachStream(sessionId, role, streamId);

    try {
      this.dispatcher.register(streamId, socket);
      this.socketOwners.set(streamId, socket);
    } catch (error) {
      this.coordinator.detachStream(sessionId, role, streamId);
      throw error;
    }
  }

  disconnect(
    sessionId: string,
    role: CallLegRole,
    streamId: string,
    socket: AudioSocket
  ): void {
    const session = this.coordinator.get(sessionId);

    if (!session) return;

    const current = session[role];

    if (!current.connected || current.streamId !== streamId) {
      return;
    }

    if (this.socketOwners.get(streamId) !== socket) {
      return;
    }

    this.dispatcher.unregister(streamId, socket);
    this.socketOwners.delete(streamId);
    this.coordinator.detachStream(sessionId, role, streamId);
  }

  complete(sessionId: string): void {
    const session = this.coordinator.get(sessionId);

    if (!session) return;

    this.coordinator.setTranslationEnabled(sessionId, false);

    for (const role of ["customer", "staff"] as const) {
      const streamId = session[role].streamId;

      if (streamId) {
        const owner = this.socketOwners.get(streamId);

        if (owner) {
          this.dispatcher.unregister(streamId, owner);
          this.socketOwners.delete(streamId);
        }

        this.coordinator.detachStream(sessionId, role, streamId);
      }
    }

    this.coordinator.remove(sessionId);
  }
}