// G.711 mu-law codec + PCM16 helpers for the Twilio media-stream bridge.
// Twilio sends/expects 8kHz mono mu-law; the rest of the pipeline is PCM16LE.

const BIAS = 0x84;
const CLIP = 32635;

function encodeSample(sample: number): number {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {
    // walk down to the highest set bit
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function decodeSample(byte: number): number {
  const inverted = ~byte & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  const sample = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -sample : sample;
}

/** PCM16LE -> mu-law (one byte per sample). */
export function mulawEncode(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = encodeSample(pcm.readInt16LE(i * 2));
  }
  return out;
}

/** mu-law -> PCM16LE (two bytes per input byte). */
export function mulawDecode(mulaw: Buffer): Buffer {
  const out = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    out.writeInt16LE(decodeSample(mulaw[i]), i * 2);
  }
  return out;
}

/**
 * Resample PCM16LE mono. Linear interpolation upsampling, block-average
 * downsampling — narrowband voice quality, no dependencies.
 */
export function resamplePcm16(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return Buffer.from(pcm);
  const inLen = Math.floor(pcm.length / 2);
  if (inLen === 0) return Buffer.alloc(0);
  const outLen = Math.max(1, Math.round((inLen * toRate) / fromRate));
  const out = Buffer.alloc(outLen * 2);
  if (toRate > fromRate) {
    const step = outLen > 1 ? (inLen - 1) / (outLen - 1) : 0;
    for (let i = 0; i < outLen; i++) {
      const pos = i * step;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, inLen - 1);
      const frac = pos - i0;
      const sample = pcm.readInt16LE(i0 * 2) * (1 - frac) + pcm.readInt16LE(i1 * 2) * frac;
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), i * 2);
    }
  } else {
    const ratio = fromRate / toRate;
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(inLen, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += pcm.readInt16LE(j * 2);
      const sample = sum / (end - start);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), i * 2);
    }
  }
  return out;
}

/** Root-mean-square energy of a PCM16LE frame (0 for empty input). */
export function rmsOfPcm16Frame(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples);
}
