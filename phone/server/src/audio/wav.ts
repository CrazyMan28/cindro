export type WavSpec = {
  sampleRate: number;
  channels: number;
  bitsPerSample?: number;
};

export function pcm16ToWav(pcm: Buffer, spec: WavSpec): Buffer {
  const bitsPerSample = spec.bitsPerSample ?? 16;
  if (bitsPerSample !== 16) {
    throw new Error(`Unsupported PCM bit depth ${bitsPerSample}; only 16-bit PCM is supported.`);
  }
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = spec.channels * bytesPerSample;
  const byteRate = spec.sampleRate * blockAlign;
  const dataSize = pcm.length;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(spec.channels, 22);
  wav.writeUInt32LE(spec.sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  pcm.copy(wav, 44);
  return wav;
}

export function isValidWavBuffer(buffer: Buffer): boolean {
  if (buffer.length < 44) return false;
  return buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE" && buffer.toString("ascii", 12, 16) === "fmt ";
}

export function assertValidWavBuffer(buffer: Buffer) {
  if (!isValidWavBuffer(buffer)) {
    throw new Error("Invalid WAV audio: missing RIFF/WAVE header.");
  }
  const audioFormat = buffer.readUInt16LE(20);
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const byteRate = buffer.readUInt32LE(28);
  const blockAlign = buffer.readUInt16LE(32);
  const bitsPerSample = buffer.readUInt16LE(34);
  const dataOffset = findChunkOffset(buffer, "data");
  if (audioFormat !== 1) throw new Error("Invalid WAV audio: only PCM WAV is supported.");
  if (channels < 1) throw new Error("Invalid WAV audio: channel count must be at least 1.");
  if (sampleRate < 8000) throw new Error("Invalid WAV audio: sample rate is too low.");
  if (bitsPerSample !== 16) throw new Error("Invalid WAV audio: only 16-bit PCM WAV is supported.");
  if (byteRate !== sampleRate * channels * (bitsPerSample / 8)) throw new Error("Invalid WAV audio: byte rate mismatch.");
  if (blockAlign !== channels * (bitsPerSample / 8)) throw new Error("Invalid WAV audio: block align mismatch.");
  if (dataOffset < 0) throw new Error("Invalid WAV audio: missing data chunk.");
}

export function extractWavPcm(buffer: Buffer): Buffer {
  assertValidWavBuffer(buffer);
  const dataOffset = findChunkOffset(buffer, "data");
  if (dataOffset < 0 || dataOffset + 8 > buffer.length) {
    throw new Error("Invalid WAV audio: malformed data chunk.");
  }
  const dataSize = buffer.readUInt32LE(dataOffset + 4);
  const start = dataOffset + 8;
  const end = Math.min(buffer.length, start + dataSize);
  return buffer.subarray(start, end);
}

function findChunkOffset(buffer: Buffer, chunkId: string) {
  for (let offset = 12; offset + 8 <= buffer.length; ) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === chunkId) return offset;
    offset += 8 + size + (size % 2);
  }
  return -1;
}
