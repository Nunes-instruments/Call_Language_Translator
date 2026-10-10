import fs from "node:fs";
import path from "node:path";
import { createDialogueFixtures } from "../src/realisticOfflineTranslationProvider.js";

const fixturesDir = path.join(process.cwd(), "fixtures", "audio");
fs.mkdirSync(fixturesDir, { recursive: true });

const fixtures = createDialogueFixtures();

// Write customer Hindi inquiry WAV & mulaw
fs.writeFileSync(
  path.join(fixturesDir, "customer_hindi_inquiry_8k.wav"),
  fixtures.customerHindi.audioWav
);
fs.writeFileSync(
  path.join(fixturesDir, "customer_hindi_inquiry_8k.mulaw"),
  fixtures.customerHindi.audioMulaw
);

// Write staff Tamil reply WAV & mulaw
fs.writeFileSync(
  path.join(fixturesDir, "staff_tamil_response_8k.wav"),
  fixtures.staffTamil.audioWav
);
fs.writeFileSync(
  path.join(fixturesDir, "staff_tamil_response_8k.mulaw"),
  fixtures.staffTamil.audioMulaw
);

// Write customer Tamil direct inquiry WAV & mulaw
fs.writeFileSync(
  path.join(fixturesDir, "customer_tamil_direct_8k.wav"),
  fixtures.customerTamilDirect.audioWav
);
fs.writeFileSync(
  path.join(fixturesDir, "customer_tamil_direct_8k.mulaw"),
  fixtures.customerTamilDirect.audioMulaw
);

console.log("Audio fixtures generated in " + fixturesDir);

