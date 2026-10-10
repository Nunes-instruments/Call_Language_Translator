export type ProtectedEntity = {
  token: string;
  original: string;
};

export type ProtectedText = {
  text: string;
  entities: ProtectedEntity[];
};

const BUSINESS_TERMS = [
  "pressure calibrator",
  "temperature calibrator",
  "process calibrator",
  "loop calibrator",
  "dry block calibrator",
  "Fluke",
  "GE Druck",
  "Druck",
  "GST",
  "ASTM",
  "ISO",
  "WhatsApp"
];

const TECHNICAL_PATTERNS: RegExp[] = [
  /₹\s?[\d,]+(?:\.\d+)?/gi,
  /(?:[$€£]|\b(?:USD|EUR|INR|Rs\.?))\s?[\d,]+(?:\.\d+)?/gi,
  /\b\d+(?:\.\d+)?\s?%/gi,
  /\b\d+(?:\.\d+)?\s?-\s?\d+(?:\.\d+)?\s?mA\b/gi,
  /\b\d+(?:\.\d+)?\s?(?:mA|A|V|mV|kV|Hz|kHz|MHz|bar|psi|Pa|kPa|MPa|°C|mm|cm|m|ml|L|LPH|sccm|Nm)\b/gi,

  // Model / part-number style identifiers.
  /\b(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:[-/][A-Z0-9]+)*\b/g,
  /\b\d[\d,]*(?:\.\d+)?\b/g
];

function rangesOverlap(
  start: number,
  end: number,
  ranges: Array<{ start: number; end: number }>
) {
  return ranges.some(range => start < range.end && end > range.start);
}

export function protectEntities(input: string, customTerms?: string[]): ProtectedText {
  const matches: Array<{
    start: number;
    end: number;
    value: string;
  }> = [];

  // Protect known business and custom technical terminology first.
  const allTerms = customTerms && customTerms.length
    ? [...new Set([...BUSINESS_TERMS, ...customTerms])]
    : BUSINESS_TERMS;

  const sortedTerms = [...allTerms].sort(
    (a, b) => b.length - a.length
  );

  for (const term of sortedTerms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      `(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`,
      "gi"
    );

    for (const match of input.matchAll(regex)) {
      if (match.index === undefined) continue;

      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        value: match[0]
      });
    }
  }

  // Then protect prices, percentages, units and model identifiers.
  for (const regex of TECHNICAL_PATTERNS) {
    for (const match of input.matchAll(regex)) {
      if (match.index === undefined) continue;

      const start = match.index;
      const end = start + match[0].length;

      if (!rangesOverlap(start, end, matches)) {
        matches.push({
          start,
          end,
          value: match[0]
        });
      }
    }
  }

  // Keep only non-overlapping longest/earliest matches.
  matches.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return (b.end - b.start) - (a.end - a.start);
  });

  const selected: typeof matches = [];

  for (const match of matches) {
    if (!rangesOverlap(match.start, match.end, selected)) {
      selected.push(match);
    }
  }

  // Replace from right to left so indexes remain valid.
  const entities: ProtectedEntity[] = [];
  let protectedText = input;

  [...selected]
    .sort((a, b) => b.start - a.start)
    .forEach((match, reverseIndex) => {
      const tokenNumber = selected.length - reverseIndex;
      const token = `NUNESENTITY${tokenNumber}`;

      entities.unshift({
        token,
        original: match.value
      });

      protectedText =
        protectedText.slice(0, match.start) +
        token +
        protectedText.slice(match.end);
    });

  return {
    text: protectedText,
    entities
  };
}

export function restoreEntities(
  translatedText: string,
  entities: ProtectedEntity[]
): string {
  let output = translatedText;

  for (const entity of entities) {
    const escaped = entity.token.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

    output = output.replace(
      new RegExp(`${escaped}(?!\\d)`, "gi"),
      entity.original
    );
  }

  return output;
}

export function verifyEntityIntegrity(
  restoredText: string,
  entities: ProtectedEntity[]
) {
  const missing = entities
    .filter(entity => !restoredText.includes(entity.original))
    .map(entity => entity.original);

  return {
    valid: missing.length === 0,
    missing
  };
}
