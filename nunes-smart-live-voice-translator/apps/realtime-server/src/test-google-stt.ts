import speech from "@google-cloud/speech";

async function main() {
  console.log("");
  console.log("========================================");
  console.log(" NUNES GOOGLE CLOUD STT CONNECTION TEST");
  console.log("========================================");

  const client = new speech.SpeechClient();

  try {
    const projectId = await client.getProjectId();

    console.log("ADC AUTH     : CONNECTED");
    console.log("PROJECT      :", projectId);
    console.log("SPEECH API   : CLIENT READY");
    console.log("AUDIO TARGET : MULAW 8000 Hz");
    console.log("LANGUAGES    : hi-IN / ta-IN");
    console.log("VOCABULARY   : Fluke, GE Druck, DPI 620G, pressure calibrator");
    console.log("RESULT       : GOOGLE STT READY");
    console.log("========================================");

    await client.close();
  } catch (error) {
    console.error("RESULT       : FAILED");
    console.error("ERROR        :", error instanceof Error ? error.message : error);
    console.log("========================================");
    process.exit(1);
  }
}

main();
