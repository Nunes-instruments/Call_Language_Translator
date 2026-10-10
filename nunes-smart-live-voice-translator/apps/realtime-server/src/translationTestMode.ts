export type TranslationTestMode = {
  enabled: boolean;
  audioIsolationVerified: boolean;
  allowLiveTranslation: boolean;
};

export function getTranslationTestMode(
  env: Record<string, string | undefined>
): TranslationTestMode {
  const enabled =
    env.NUNES_TRANSLATION_TEST_MODE === "true";

  // Never activate live translation without verified isolation.
  const audioIsolationVerified = false;

  return {
    enabled,
    audioIsolationVerified,
    allowLiveTranslation: enabled && audioIsolationVerified
  };
}
