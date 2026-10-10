/** G.711 mu-law and mono PCM16 WAV only; unknown containers/formats fail closed. */
export function decodeMulaw(input: Buffer): Int16Array {
  const pcm = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const value = (~input[i]) & 255;
    const magnitude = (((value & 15) << 3) + 132) << ((value >> 4) & 7);
    pcm[i] = (value & 128) ? 132 - magnitude : magnitude - 132;
  }
  return pcm;
}
export function encodeMulaw(pcm: Int16Array): Buffer {
  const output = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const sign = pcm[i] < 0 ? 128 : 0;
    let value = Math.min(32635, Math.abs(pcm[i])) + 132;
    let exponent = 7;
    for (let mask = 0x4000; exponent > 0 && !(value & mask); mask >>= 1) exponent--;
    output[i] = (~(sign | (exponent << 4) | ((value >> (exponent + 3)) & 15))) & 255;
  }
  return output;
}
export function pcm16Wav(pcm: Int16Array, sampleRate = 8000): Buffer {
  if (![8000, 16000, 24000].includes(sampleRate)) throw new Error("UNSUPPORTED_SAMPLE_RATE");
  const wav = Buffer.alloc(44 + pcm.length * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) wav.writeInt16LE(pcm[i], 44 + i * 2);
  return wav;
}
export function readPcm16Wav(wav: Buffer): { pcm: Int16Array; sampleRate: number } {
  if (wav.length < 44 || wav.length > 2_000_000 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE" || wav.readUInt32LE(4) + 8 !== wav.length) throw new Error("INVALID_WAV");
  let sampleRate = 0;
  let data: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString("ascii", offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end > wav.length) throw new Error("TRUNCATED_WAV");
    if (id === "fmt ") {
      if (sampleRate || length < 16 || wav.readUInt16LE(offset + 8) !== 1 || wav.readUInt16LE(offset + 10) !== 1 || wav.readUInt16LE(offset + 22) !== 16 || wav.readUInt16LE(offset + 20) !== 2) throw new Error("UNSUPPORTED_WAV_FORMAT");
      sampleRate = wav.readUInt32LE(offset + 12);
      if (![8000, 16000, 24000].includes(sampleRate) || wav.readUInt32LE(offset + 16) !== sampleRate * 2) throw new Error("UNSUPPORTED_SAMPLE_RATE");
    } else if (id === "data") {
      if (data || !length || length % 2) throw new Error("INVALID_WAV_DATA");
      data = wav.subarray(offset + 8, end);
    }
    offset = end + (length % 2);
  }
  if (!sampleRate || !data) throw new Error("MISSING_WAV_CHUNKS");
  const pcm = new Int16Array(data.length / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(i * 2);
  return { pcm, sampleRate };
}
export function wavToPlivoMulaw(wav: Buffer): Buffer {
  const { pcm, sampleRate } = readPcm16Wav(wav);
  if (sampleRate === 8000) return encodeMulaw(pcm);
  // Integer-rate box filter before decimation; telephony fidelity still needs provider testing.
  const factor = sampleRate / 8000;
  const downsampled = new Int16Array(Math.floor(pcm.length / factor));
  for (let i = 0; i < downsampled.length; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) sum += pcm[i * factor + j];
    downsampled[i] = Math.round(sum / factor);
  }
  return encodeMulaw(downsampled);
}
export function validAudioBase64(value: unknown, maxBytes = 80_000): Buffer {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("INVALID_AUDIO_PAYLOAD");
  const data = Buffer.from(value, "base64");
  if (!data.length || data.length > maxBytes || data.toString("base64") !== value) throw new Error("INVALID_AUDIO_PAYLOAD");
  return data;
}
