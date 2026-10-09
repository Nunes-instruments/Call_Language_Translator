export type AudioIsolationEvidence = {
  customerLegIsolated: boolean;
  staffLegIsolated: boolean;
  originalAudioNotCrossBridged: boolean;
  customerPlaybackVerified: boolean;
  staffPlaybackVerified: boolean;
  disconnectCleanupVerified: boolean;
};

export type AudioIsolationAssessment = {
  passed: boolean;
  missing: string[];
  productionActivationAllowed: false;
};

export function assessAudioIsolation(
  evidence: Partial<AudioIsolationEvidence>
): AudioIsolationAssessment {
  const required: (keyof AudioIsolationEvidence)[] = [
    "customerLegIsolated",
    "staffLegIsolated",
    "originalAudioNotCrossBridged",
    "customerPlaybackVerified",
    "staffPlaybackVerified",
    "disconnectCleanupVerified"
  ];

  const missing = required.filter(
    key => evidence[key] !== true
  );

  return {
    passed: missing.length === 0,
    missing,
    // Evidence assessment is NOT production authorization.
    productionActivationAllowed: false
  };
}
