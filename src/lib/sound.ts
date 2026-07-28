import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { File, Paths } from 'expo-file-system';

import { SHIMMER_DURATION_S, synthesiseShimmerWav } from '@/lib/shimmerSynth';

/**
 * Sound effects for the introduction round.
 *
 * Two rules shape this module:
 *
 * 1. **Never interrupt the user's own audio.** Someone browsing introductions
 *    with a Quran recitation or a podcast playing should keep hearing it — a UI
 *    blip is not worth stealing the audio session for. Hence `mixWithOthers`.
 * 2. **Respect the silent switch.** `playsInSilentMode: false` means a phone on
 *    silent stays silent. That matters more than usual for this app, which
 *    people may well use somewhere they would be embarrassed to make noise.
 */

/**
 * Six recorded tear variants, differing in both pitch and grain texture. A
 * single sample retriggered over and over is the thing that makes UI audio
 * grating, and real tears never sound identical twice.
 */
const POP_SOURCES = [
  require('../../assets/audio/pop-1.wav'),
  require('../../assets/audio/pop-2.wav'),
  require('../../assets/audio/pop-3.wav'),
  require('../../assets/audio/pop-4.wav'),
  require('../../assets/audio/pop-5.wav'),
  require('../../assets/audio/pop-6.wav'),
];

/** Length of the bundled fallback loop, used only if synthesis is unavailable. */
const FALLBACK_LOOP_MS = 5000;
const SHIMMER_PEAK = 0.28;

let configured = false;
let shimmerFile: File | null = null;
let generation = 0;
const popPlayers: (AudioPlayer | null)[] = POP_SOURCES.map(() => null);
let lastPopIndex = -1;
let shimmerPlayer: AudioPlayer | null = null;
let shimmerOn = false;
let fadeTimer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null = null;

/** Global off switch, so a settings toggle can silence everything. */
let enabled = true;

export function setSoundEnabled(next: boolean): void {
  enabled = next;
  if (!next) stopShimmer();
}

async function configure(): Promise<void> {
  if (configured) return;
  configured = true;
  try {
    await setAudioModeAsync({
      playsInSilentMode: false,
      interruptionMode: 'mixWithOthers',
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    });
  } catch {
    // Audio is decoration here. If the session cannot be configured, the app
    // carries on silently rather than failing.
  }
}

/**
 * The balloon pop. Synthesised rather than sampled — see `assets/audio`.
 *
 * Seeks to zero before playing so rapid taps retrigger cleanly instead of
 * being swallowed while the previous one finishes.
 */
export function playPop(): void {
  if (!enabled) return;
  void configure();

  // Never the same variant twice in a row — back-to-back repeats are exactly
  // what gives the game away that this is a sample.
  let index = Math.floor(Math.random() * POP_SOURCES.length);
  if (index === lastPopIndex) index = (index + 1) % POP_SOURCES.length;
  lastPopIndex = index;

  try {
    let player = popPlayers[index];
    if (!player) {
      player = createAudioPlayer(POP_SOURCES[index]);
      player.volume = 0.5;
      popPlayers[index] = player;
    }
    player.seekTo(0);
    player.play();
  } catch {
    // Never let a missing codec break the interaction.
  }
}

/**
 * The chosen-one shimmer.
 *
 * Synthesised fresh on every call — ten seconds, at level for five and fading
 * to silence by ten, then done. Because the envelope is rendered into the
 * samples themselves, the fade is sample-accurate; there is no volume timer to
 * drift or stall.
 */
export function startShimmer(): void {
  if (!enabled || shimmerOn) return;
  void configure();

  shimmerOn = true;
  const mine = ++generation;

  // Rendering ~220k samples blocks the JS thread briefly. Deferring a tick lets
  // the chosen-state transition paint first, so the hitch is never seen.
  setTimeout(() => {
    if (!shimmerOn || mine !== generation) return;
    try {
      const bytes = synthesiseShimmerWav();

      // A new filename each time: overwriting in place can leave the player
      // reading a half-written file.
      disposeShimmerFile();
      const file = new File(Paths.cache, `shimmer-${mine}.wav`);
      file.create({ overwrite: true });
      file.write(bytes);
      shimmerFile = file;

      shimmerPlayer?.remove();
      shimmerPlayer = createAudioPlayer({ uri: file.uri });
      shimmerPlayer.loop = false;
      shimmerPlayer.volume = 1;
      shimmerPlayer.play();

      // Nothing loops, so it ends on its own — this just releases the handles.
      fadeTimer = setTimeout(() => {
        if (mine === generation) stopShimmer();
      }, SHIMMER_DURATION_S * 1000 + 250);
    } catch {
      playFallbackShimmer(mine);
    }
  }, 0);
}

/**
 * Bundled 5s loop with a timed volume ramp, matching the procedural shape:
 * level for five seconds, gone by ten. Only reached if synthesis or the cache
 * write fails.
 */
function playFallbackShimmer(mine: number): void {
  try {
    if (!shimmerPlayer) {
      shimmerPlayer = createAudioPlayer(require('../../assets/audio/shimmer.wav'));
      shimmerPlayer.loop = true;
    }
    shimmerPlayer.volume = SHIMMER_PEAK;
    shimmerPlayer.seekTo(0);
    shimmerPlayer.play();

    const startedAt = Date.now();
    fadeTimer = setInterval(() => {
      if (!shimmerPlayer || !shimmerOn || mine !== generation) return clearFade();
      const elapsed = Date.now() - startedAt;
      if (elapsed <= FALLBACK_LOOP_MS) return;

      const t = (elapsed - FALLBACK_LOOP_MS) / FALLBACK_LOOP_MS;
      if (t >= 1) return stopShimmer();
      try {
        shimmerPlayer.volume = SHIMMER_PEAK * 0.5 * (1 + Math.cos(Math.PI * t));
      } catch {
        clearFade();
      }
    }, 80);
  } catch {
    shimmerOn = false;
  }
}

function clearFade(): void {
  if (fadeTimer) {
    clearInterval(fadeTimer as ReturnType<typeof setInterval>);
    clearTimeout(fadeTimer as ReturnType<typeof setTimeout>);
  }
  fadeTimer = null;
}

function disposeShimmerFile(): void {
  try {
    shimmerFile?.delete();
  } catch {
    // A leftover in the cache directory is harmless.
  }
  shimmerFile = null;
}

export function stopShimmer(): void {
  clearFade();
  generation++;
  if (!shimmerOn) return;
  try {
    shimmerPlayer?.pause();
  } catch {
    // Ignore — the player may already be released.
  }
  shimmerOn = false;
}

/** Frees both players. Call when the round screen unmounts for good. */
export function releaseSounds(): void {
  stopShimmer();
  popPlayers.forEach((player, index) => {
    player?.remove();
    popPlayers[index] = null;
  });
  shimmerPlayer?.remove();
  shimmerPlayer = null;
  disposeShimmerFile();
}
