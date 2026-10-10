export type PlivoStreamOptions = {
  bidirectional: boolean;
  audioTrack: "inbound";
  contentType: "audio/x-mulaw;rate=8000";
};

export type PlivoStreamClient = {
  calls: {
    stream: (
      callUuid: string,
      serviceUrl: string,
      options: PlivoStreamOptions
    ) => Promise<unknown>;
    stopAllStream: (callUuid: string) => Promise<unknown>;
  };
};

export class PlivoStreamAdapter {
  constructor(
    private readonly client: PlivoStreamClient,
    private readonly serviceUrl: string
  ) {
    if (!serviceUrl.startsWith("wss://")) {
      throw new Error("Secure WebSocket URL required");
    }
  }

  async start(callUuid: string): Promise<unknown> {
    if (!callUuid) {
      throw new Error("Call UUID required");
    }

    return this.client.calls.stream(
      callUuid,
      this.serviceUrl,
      {
        bidirectional: true,
        audioTrack: "inbound",
        contentType: "audio/x-mulaw;rate=8000"
      }
    );
  }

  async stop(callUuid: string): Promise<unknown> {
    if (!callUuid) {
      throw new Error("Call UUID required");
    }

    return this.client.calls.stopAllStream(callUuid);
  }
}
