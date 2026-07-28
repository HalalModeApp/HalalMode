/**
 * Procedural shimmer synthesis.
 *
 * The first version of this randomised only *where* grains fell, while the
 * scale, density, grain length and tremolo stayed fixed. The result was
 * technically different every time and audibly identical every time.
 *
 * So the whole voice is now redrawn per render: a new key, a new mode, a new
 * texture, a new tremolo character. Two shimmers should sound related — same
 * family, same restraint — without sounding like the same recording.
 *
 * The amplitude envelope (level to five seconds, silent by ten) is baked into
 * the samples rather than applied by a volume timer, so the fade is
 * sample-accurate and cannot drift if the JS thread stalls.
 */

const SAMPLE_RATE = 22050;
export const SHIMMER_DURATION_S = 10;
const FADE_BEGINS_S = 5;

/** Peak level. Deliberately low — this sits under the interface. */
const PEAK = 0.3;

/**
 * Interval sets in semitones. All are gapped or symmetrical, so none of them
 * resolve to a tonic — a shimmer should never sound like a tune.
 */
const MODES: number[][] = [
  [0, 2, 4, 7, 9],       // major pentatonic — the reference's own
  [0, 3, 5, 7, 10],      // minor pentatonic
  [0, 2, 4, 6, 8, 10],   // whole tone
  [0, 2, 3, 7, 8],       // hirajoshi
  [0, 2, 4, 6, 7, 9],    // lydian, no seventh
  [0, 5, 7],             // stacked fourths and fifths
  [0, 2, 7, 9],          // open seconds
];

type Texture = 'ping' | 'bell' | 'mixed';
type Tremolo = 'none' | 'slowDeep' | 'fastShallow';

function between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

/**
 * One complete set of voice parameters. Everything that defines how a shimmer
 * *sounds*, as opposed to how its grains happen to land.
 */
interface Voice {
  frequencies: number[];
  grainCount: number;
  lengthMin: number;
  lengthMax: number;
  decay: number;
  tremoloHzMin: number;
  tremoloHzMax: number;
  tremoloDepth: number;
  detune: number;
}

function drawVoice(): Voice {
  const mode = pick(MODES);

  // Root anywhere across a fifth, so successive shimmers sit in different keys.
  const root = 2600 * Math.pow(2, between(-3, 7) / 12);

  // Two octaves of the chosen mode.
  const frequencies: number[] = [];
  for (let octave = 0; octave < 2; octave++) {
    for (const step of mode) {
      frequencies.push(root * Math.pow(2, (step + octave * 12) / 12));
    }
  }

  const texture: Texture = pick<Texture>(['ping', 'bell', 'mixed']);
  const [lengthMin, lengthMax] =
    texture === 'ping'
      ? [0.10, 0.28]
      : texture === 'bell'
        ? [0.45, 1.10]
        : [0.20, 0.75];

  // Sparse and bell-like, or dense and glittering — never the same balance.
  const grainCount =
    texture === 'bell'
      ? Math.floor(between(26, 48))
      : Math.floor(between(55, 115));

  const tremolo: Tremolo = pick<Tremolo>(['none', 'slowDeep', 'fastShallow']);
  const [tremoloHzMin, tremoloHzMax, tremoloDepth] =
    tremolo === 'none'
      ? [1, 1, 0]
      : tremolo === 'slowDeep'
        ? [4, 8, between(0.45, 0.7)]
        : [12, 22, between(0.15, 0.35)];

  return {
    frequencies,
    grainCount,
    lengthMin,
    lengthMax,
    decay: between(0.12, 0.4),
    tremoloHzMin,
    tremoloHzMax,
    tremoloDepth,
    detune: between(0.002, 0.012),
  };
}

function render(): Float32Array {
  const total = SAMPLE_RATE * SHIMMER_DURATION_S;
  const buffer = new Float32Array(total);
  const voice = drawVoice();

  for (let g = 0; g < voice.grainCount; g++) {
    const base = pick(voice.frequencies);
    const frequency = base * (1 + between(-voice.detune, voice.detune));
    const length = Math.floor(
      SAMPLE_RATE * between(voice.lengthMin, voice.lengthMax)
    );
    const attack = Math.floor(SAMPLE_RATE * between(0.02, 0.09));
    const tremoloHz = between(voice.tremoloHzMin, voice.tremoloHzMax);
    const amplitude = between(0.5, 1);

    // Weighted toward the start, so the shimmer is densest while it is at full
    // level and thins out as the fade takes hold. The exponent must be greater
    // than one to skew early — below one skews the other way.
    const start = Math.floor(Math.pow(Math.random(), 1.7) * (total - length));

    const omega = (2 * Math.PI * frequency) / SAMPLE_RATE;
    const tremoloOmega = (2 * Math.PI * tremoloHz) / SAMPLE_RATE;

    // The tremolo is a control signal of at most 22 Hz, so recomputing it every
    // sample is waste. Stepping every 32 keeps ~1.5ms resolution and halves the
    // transcendental calls in the hot loop.
    const TREMOLO_STEP = 32;
    let tremolo = 1;

    for (let k = 0; k < length; k++) {
      if (voice.tremoloDepth > 0 && k % TREMOLO_STEP === 0) {
        tremolo =
          1 -
          voice.tremoloDepth +
          voice.tremoloDepth * (0.5 + 0.5 * Math.sin(tremoloOmega * k));
      }
      const envelope =
        k < attack
          ? k / attack
          : Math.exp(-((k - attack) / SAMPLE_RATE) / voice.decay);
      buffer[start + k]! += Math.sin(omega * k) * envelope * tremolo * amplitude;
    }
  }

  // Normalise, then impose the master envelope.
  let peak = 0;
  for (let i = 0; i < total; i++) {
    const magnitude = Math.abs(buffer[i]!);
    if (magnitude > peak) peak = magnitude;
  }
  const gain = peak > 0 ? PEAK / peak : 0;

  const fadeStart = SAMPLE_RATE * FADE_BEGINS_S;
  const fadeLength = total - fadeStart;
  const leadIn = Math.floor(SAMPLE_RATE * 0.15);

  for (let i = 0; i < total; i++) {
    let envelope = 1;
    // Short lead-in so playback never begins on a step.
    if (i < leadIn) envelope = i / leadIn;
    if (i >= fadeStart) {
      // Raised cosine: eases out of level and into silence, so the tail simply
      // stops being there rather than audibly arriving at zero.
      const t = (i - fadeStart) / fadeLength;
      envelope *= 0.5 * (1 + Math.cos(Math.PI * t));
    }
    buffer[i] = buffer[i]! * gain * envelope;
  }

  return buffer;
}

/** Wraps PCM samples in a canonical 44-byte WAV header. */
export function synthesiseShimmerWav(): Uint8Array {
  const samples = render();
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);              // PCM header size
  view.setUint16(20, 1, true);               // format: PCM
  view.setUint16(22, 1, true);               // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true);               // block align
  view.setUint16(34, 16, true);              // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(offset, Math.round(clamped * 32767), true);
    offset += 2;
  }

  return bytes;
}
