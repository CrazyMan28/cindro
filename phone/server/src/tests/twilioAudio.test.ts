import { describe, expect, test } from "vitest";
import { mulawDecode, mulawEncode, resamplePcm16, rmsOfPcm16Frame } from "../audio/g711.js";
import { UtteranceSegmenter } from "../audio/utteranceSegmenter.js";

function pcm16Buffer(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => buf.writeInt16LE(sample, i * 2));
  return buf;
}

function pcm16Samples(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < buf.length; i += 2) out.push(buf.readInt16LE(i));
  return out;
}

describe("g711 mulaw codec", () => {
  test("encodes one byte per sample and decodes two bytes per byte", () => {
    const pcm = pcm16Buffer([0, 1000, -1000, 32000]);
    const encoded = mulawEncode(pcm);
    expect(encoded.length).toBe(4);
    expect(mulawDecode(encoded).length).toBe(8);
  });

  test("mulaw silence byte decodes to zero", () => {
    expect(pcm16Samples(mulawDecode(Buffer.from([0xff])))[0]).toBe(0);
  });

  test("round-trip preserves samples within mulaw quantization error", () => {
    const values = [0, 100, -100, 1000, -1000, 8000, -8000, 30000, -30000];
    const decoded = pcm16Samples(mulawDecode(mulawEncode(pcm16Buffer(values))));
    values.forEach((value, i) => {
      // mulaw is logarithmic: tolerance scales with amplitude
      const tolerance = Math.max(16, Math.abs(value) * 0.07);
      expect(Math.abs(decoded[i] - value)).toBeLessThanOrEqual(tolerance);
    });
  });

  test("round-trip preserves the shape of a sine tone", () => {
    const samples = Array.from({ length: 160 }, (_, i) => Math.round(12000 * Math.sin((2 * Math.PI * 400 * i) / 8000)));
    const decoded = pcm16Samples(mulawDecode(mulawEncode(pcm16Buffer(samples))));
    const inputRms = rmsOfPcm16Frame(pcm16Buffer(samples));
    const outputRms = rmsOfPcm16Frame(pcm16Buffer(decoded));
    expect(Math.abs(inputRms - outputRms) / inputRms).toBeLessThan(0.05);
  });
});

describe("resamplePcm16", () => {
  test("8k to 16k doubles the sample count", () => {
    const pcm = pcm16Buffer(Array.from({ length: 80 }, () => 1234));
    expect(resamplePcm16(pcm, 8000, 16000).length).toBe(pcm.length * 2);
  });

  test("16k to 8k halves the sample count", () => {
    const pcm = pcm16Buffer(Array.from({ length: 160 }, () => -421));
    expect(resamplePcm16(pcm, 16000, 8000).length).toBe(pcm.length / 2);
  });

  test("same rate returns identical audio", () => {
    const pcm = pcm16Buffer([5, -10, 300, -4000]);
    expect(resamplePcm16(pcm, 8000, 8000).equals(pcm)).toBe(true);
  });

  test("preserves a DC signal", () => {
    const pcm = pcm16Buffer(Array.from({ length: 100 }, () => 7000));
    const up = pcm16Samples(resamplePcm16(pcm, 8000, 16000));
    const down = pcm16Samples(resamplePcm16(pcm, 16000, 8000));
    for (const sample of up) expect(Math.abs(sample - 7000)).toBeLessThanOrEqual(1);
    for (const sample of down) expect(Math.abs(sample - 7000)).toBeLessThanOrEqual(1);
  });

  test("24k to 8k keeps a tone's energy roughly intact", () => {
    const samples = Array.from({ length: 240 }, (_, i) => Math.round(10000 * Math.sin((2 * Math.PI * 300 * i) / 24000)));
    const out = resamplePcm16(pcm16Buffer(samples), 24000, 8000);
    expect(out.length).toBe(160);
    const ratio = rmsOfPcm16Frame(out) / rmsOfPcm16Frame(pcm16Buffer(samples));
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.2);
  });
});

describe("rmsOfPcm16Frame", () => {
  test("silence has zero rms", () => {
    expect(rmsOfPcm16Frame(pcm16Buffer([0, 0, 0, 0]))).toBe(0);
  });

  test("constant amplitude has that rms", () => {
    expect(Math.abs(rmsOfPcm16Frame(pcm16Buffer([2000, -2000, 2000, -2000])) - 2000)).toBeLessThan(1);
  });

  test("empty buffer is zero, not NaN", () => {
    expect(rmsOfPcm16Frame(Buffer.alloc(0))).toBe(0);
  });
});

// Mirrors android/app/src/test/java/com/agentphone/VadSegmenterTest.kt so both ends segment identically.
describe("UtteranceSegmenter", () => {
  const segmenter = () =>
    new UtteranceSegmenter({ startRms: 1000, endRms: 500, minSpeechFrames: 3, silenceFramesToEnd: 4 });

  test("emits start only after speech is sustained", () => {
    const vad = segmenter();
    expect(vad.accept(2000)).toBe("none");
    expect(vad.accept(2000)).toBe("none");
    expect(vad.accept(2000)).toBe("utterance_start");
    expect(vad.accept(2000)).toBe("none");
  });

  test("ignores short blip below minSpeechFrames", () => {
    const vad = segmenter();
    expect(vad.accept(2000)).toBe("none");
    expect(vad.accept(2000)).toBe("none");
    expect(vad.accept(50)).toBe("none");
    expect(vad.accept(2000)).toBe("none");
    expect(vad.accept(2000)).toBe("none");
  });

  test("ends after trailing silence", () => {
    const vad = segmenter();
    vad.accept(2000);
    vad.accept(2000);
    expect(vad.accept(2000)).toBe("utterance_start");
    expect(vad.accept(2000)).toBe("none");
    expect(vad.accept(100)).toBe("none");
    expect(vad.accept(100)).toBe("none");
    expect(vad.accept(100)).toBe("none");
    expect(vad.accept(100)).toBe("utterance_end");
  });

  test("speech resets silence run so a pause does not end the turn", () => {
    const vad = segmenter();
    for (let i = 0; i < 3; i++) vad.accept(2000);
    for (let i = 0; i < 3; i++) expect(vad.accept(100)).toBe("none");
    expect(vad.accept(2000)).toBe("none");
    for (let i = 0; i < 3; i++) expect(vad.accept(100)).toBe("none");
  });

  test("end() flushes when speaking, then is idle", () => {
    const vad = segmenter();
    for (let i = 0; i < 3; i++) vad.accept(2000);
    expect(vad.end()).toBe("utterance_end");
    expect(vad.end()).toBe("none");
  });

  test("end() is a no-op when idle", () => {
    expect(segmenter().end()).toBe("none");
  });

  test("supports back-to-back utterances", () => {
    const vad = segmenter();
    vad.accept(2000);
    vad.accept(2000);
    expect(vad.accept(2000)).toBe("utterance_start");
    for (let i = 0; i < 3; i++) vad.accept(100);
    expect(vad.accept(100)).toBe("utterance_end");
    vad.accept(2000);
    vad.accept(2000);
    expect(vad.accept(2000)).toBe("utterance_start");
  });
});
