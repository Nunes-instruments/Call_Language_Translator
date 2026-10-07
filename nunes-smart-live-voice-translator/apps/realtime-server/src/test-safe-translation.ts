import {
  protectEntities,
  restoreEntities,
  verifyEntityIntegrity
} from "@nunes/translation";

const apiKey = process.env.SARVAM_API_KEY;

if (!apiKey) {
  console.error("SARVAM_API_KEY : MISSING");
  process.exit(1);
}

const input =
  "मुझे Fluke pressure calibrator चाहिए। कीमत ₹25,000 plus 18% GST है। GE Druck DPI 620G, ASTM और 4-20 mA specification confirm कीजिए।";

async function main() {
  console.log("");
  console.log("==========================================");
  console.log(" NUNES SAFE TRANSLATION PIPELINE");
  console.log("==========================================");

  const protectedResult = protectEntities(input);

  console.log(`ORIGINAL  : ${input}`);
  console.log(`PROTECTED : ${protectedResult.text}`);

  console.log("");
  console.log("PROTECTED ENTITIES:");

  for (const entity of protectedResult.entities) {
    console.log(` ${entity.token} -> ${entity.original}`);
  }

  const started = performance.now();

  const response = await fetch(
    "https://api.sarvam.ai/translate",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": apiKey
      },
      body: JSON.stringify({
        input: protectedResult.text,
        source_language_code: "hi-IN",
        target_language_code: "ta-IN",
        model: "sarvam-translate:v1"
      })
    }
  );

  const latency = Math.round(performance.now() - started);
  const rawBody = await response.text();

  if (!response.ok) {
    throw new Error(
      `SARVAM FAILED ${response.status}: ${rawBody}`
    );
  }

  const result = JSON.parse(rawBody);

  const translated = result.translated_text ?? "";

  const restored = restoreEntities(
    translated,
    protectedResult.entities
  );

  const integrity = verifyEntityIntegrity(
    restored,
    protectedResult.entities
  );

  console.log("");
  console.log(`SARVAM RAW : ${translated}`);
  console.log(`RESTORED   : ${restored}`);
  console.log(`LATENCY    : ${latency} ms`);

  console.log("");
  console.log("==========================================");

  if (!integrity.valid) {
    console.log("ENTITY INTEGRITY : FAIL");
    console.log(
      `MISSING          : ${integrity.missing.join(", ")}`
    );

    process.exitCode = 1;
    return;
  }

  console.log("ENTITY INTEGRITY : PASS");
  console.log("TRANSLATION      : PASS");
  console.log("==========================================");

  console.log("");
  console.log("EXPECTED EXACT TERMS:");
  console.log(" Fluke");
  console.log(" pressure calibrator");
  console.log(" ₹25,000");
  console.log(" 18%");
  console.log(" GST");
  console.log(" GE Druck");
  console.log(" DPI 620G");
  console.log(" ASTM");
  console.log(" 4-20 mA");

  console.log("");
  console.log(" SAFE TRANSLATION PIPELINE READY");
}

main().catch(error => {
  console.error("");
  console.error(
    "SAFE TRANSLATION TEST FAILED:",
    error instanceof Error ? error.message : error
  );
  process.exit(1);
});
