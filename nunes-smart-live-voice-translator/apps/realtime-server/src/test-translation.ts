const apiKey = process.env.SARVAM_API_KEY;

if (!apiKey) {
  console.error("SARVAM_API_KEY : MISSING");
  process.exit(1);
}

const tests = [
  {
    name: "NORMAL HINDI",
    input: "मुझे एक प्रेशर कैलिब्रेटर चाहिए। इसकी कीमत और डिलीवरी टाइम बताइए।"
  },
  {
    name: "BUSINESS TERMS",
    input: "मुझे Fluke pressure calibrator चाहिए। कीमत ₹25,000 plus 18% GST है। Delivery 7 days में चाहिए।"
  },
  {
    name: "MODEL + STANDARD",
    input: "GE Druck DPI 620G चाहिए। ASTM standard और 4-20 mA specification confirm कीजिए।"
  }
];

async function translate(input: string) {
  const started = performance.now();

  const response = await fetch("https://api.sarvam.ai/translate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": apiKey
    },
    body: JSON.stringify({
      input,
      source_language_code: "hi-IN",
      target_language_code: "ta-IN",
      model: "sarvam-translate:v1"
    })
  });

  const elapsed = Math.round(performance.now() - started);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `SARVAM TRANSLATION FAILED ${response.status}: ${body}`
    );
  }

  const result = JSON.parse(body);

  return {
    translatedText: result.translated_text,
    sourceLanguage: result.source_language_code,
    requestId: result.request_id,
    latencyMs: elapsed
  };
}

console.log("");
console.log("==========================================");
console.log(" NUNES HINDI -> TAMIL TRANSLATION TEST");
console.log("==========================================");

for (const test of tests) {
  console.log("");
  console.log("------------------------------------------");
  console.log(`TEST   : ${test.name}`);
  console.log("------------------------------------------");
  console.log(`HINDI  : ${test.input}`);

  try {
    const result = await translate(test.input);

    console.log(`TAMIL  : ${result.translatedText}`);
    console.log(`SOURCE : ${result.sourceLanguage}`);
    console.log(`LATENCY: ${result.latencyMs} ms`);
    console.log("STATUS : PASS");
  } catch (error) {
    console.error(
      "STATUS : FAIL",
      error instanceof Error ? error.message : error
    );
  }
}

console.log("");
console.log("==========================================");
console.log(" TRANSLATION TEST COMPLETE");
console.log("==========================================");
