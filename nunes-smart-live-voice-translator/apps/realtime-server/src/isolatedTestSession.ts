export type IsolatedTestSession = {
  sessionId: string;
  customerUuid: string;
  staffUuid: string;
  mode: "simulation";
  translationEnabled: false;
  audioIsolationVerified: false;
};

export function createIsolatedTestSession(
  sessionId: string,
  customerUuid: string,
  staffUuid: string
): IsolatedTestSession {
  if (!sessionId.trim() || !customerUuid.trim() || !staffUuid.trim()) {
    throw new Error("All session identifiers are required");
  }

  if (customerUuid === staffUuid) {
    throw new Error("Customer and staff legs must be different");
  }

  return {
    sessionId,
    customerUuid,
    staffUuid,
    mode: "simulation",
    translationEnabled: false,
    audioIsolationVerified: false
  };
}

export function activateIsolatedTestTranslation(
  _session: IsolatedTestSession
): never {
  throw new Error(
    "Live translation blocked: audio isolation has not been verified"
  );
}
