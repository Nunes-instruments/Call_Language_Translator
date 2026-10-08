import {
  TwoLegAudioCoordinator,
  type CallLegRole
} from "./twoLegAudioCoordinator";

export type AudioSocket = {
  readyState: number;
  send: (message: string) => void;
};

export type AudioDispatchResult =
  | { delivered: true; destination: CallLegRole }
  | { delivered: false; reason: string };

export class CrossLegAudioDispatcher {
  private sockets = new Map<string, AudioSocket>();

  constructor(
    private readonly coordinator: TwoLegAudioCoordinator
  ) {}

  register(streamId: string, socket: AudioSocket): void {
    if (!streamId) throw new Error("Stream ID required");
    this.sockets.set(streamId, socket);
  }

  unregister(streamId: string): void {
    this.sockets.delete(streamId);
  }

  dispatch(
    sessionId: string,
    speaker: CallLegRole,
    audioBase64: string
  ): AudioDispatchResult {
    const session = this.coordinator.get(sessionId);

    if (!session) {
      return { delivered: false, reason: "UNKNOWN_SESSION" };
    }

    if (!session.translationEnabled) {
      return { delivered: false, reason: "TRANSLATION_DISABLED" };
    }

    const source = session[speaker];

    if (!source.connected || !source.streamId) {
      return { delivered: false, reason: "SOURCE_DISCONNECTED" };
    }

    const destinationRole = this.coordinator.opposite(speaker);
    const destination =
      this.coordinator.getDestination(sessionId, speaker);

    if (!destination?.streamId) {
      return { delivered: false, reason: "DESTINATION_DISCONNECTED" };
    }

    const socket = this.sockets.get(destination.streamId);

    if (!socket || socket.readyState !== 1) {
      return { delivered: false, reason: "DESTINATION_SOCKET_NOT_OPEN" };
    }

    if (!audioBase64) {
      return { delivered: false, reason: "EMPTY_AUDIO" };
    }

    socket.send(JSON.stringify({
      event: "playAudio",
      media: {
        contentType: "audio/x-mulaw",
        sampleRate: 8000,
        payload: audioBase64
      }
    }));

    return { delivered: true, destination: destinationRole };
  }
}
