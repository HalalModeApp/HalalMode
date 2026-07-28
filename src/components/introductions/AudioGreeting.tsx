import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui/Text';
import { alpha, color, font, radius } from '@/theme/tokens';

const BAR_COUNT = 26;

export interface AudioGreetingProps {
  durationSeconds: number;
  /** Absent in the sample data — the waveform still scrubs so the UI is real. */
  url?: string;
  /** Chat bubbles use the compact form with no surrounding card. */
  compact?: boolean;
  /** Inverts for the sent-message bubble. */
  onDark?: boolean;
}

/**
 * Voice greeting player.
 *
 * The waveform is derived from the duration rather than decoded from the file —
 * a real FFT would cost a native module and a decode pass for a 16-second clip
 * that is decoration. Playback position is honest; the bar heights are not.
 */
export function AudioGreeting({
  durationSeconds,
  url,
  compact,
  onDark,
}: AudioGreetingProps) {
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const bars = useMemo(
    () =>
      Array.from({ length: BAR_COUNT }, (_, i) => {
        const seed = i * 1.7 + durationSeconds;
        return 4 + (Math.sin(seed) * 0.5 + 0.5) * 14;
      }),
    [durationSeconds]
  );

  useEffect(() => {
    if (!playing) {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      return;
    }

    timer.current = setInterval(() => {
      setElapsed((current) => {
        if (current + 0.5 >= durationSeconds) {
          setPlaying(false);
          return 0;
        }
        return current + 0.5;
      });
    }, 500);

    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, durationSeconds]);

  const progress = durationSeconds > 0 ? elapsed / durationSeconds : 0;
  const remaining = Math.max(0, Math.round(durationSeconds - elapsed));
  const timeLabel = `0:${String(remaining).padStart(2, '0')}`;

  const tint = onDark ? color.white : color.ink;
  const idleBar = onDark ? 'rgba(252,252,251,0.35)' : 'rgba(10,10,10,0.16)';

  return (
    <View style={[styles.row, !compact && styles.card]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={playing ? 'Pause voice greeting' : 'Play voice greeting'}
        accessibilityHint={url ? undefined : 'Sample audio'}
        onPress={() => setPlaying((on) => !on)}
        style={[
          styles.play,
          { backgroundColor: onDark ? color.white : color.ink },
        ]}
      >
        <Text
          style={[styles.playGlyph, { color: onDark ? color.ink : color.white }]}
        >
          {playing ? '❚❚' : '▶'}
        </Text>
      </Pressable>

      <View style={styles.wave}>
        {bars.map((height, index) => {
          const reached = index / BAR_COUNT <= progress;
          return (
            <View
              key={index}
              style={{
                width: 2,
                height,
                borderRadius: 1,
                backgroundColor: reached ? tint : idleBar,
              }}
            />
          );
        })}
      </View>

      <Text
        style={[
          styles.time,
          { color: onDark ? 'rgba(252,252,251,0.6)' : color.faint },
        ]}
      >
        {timeLabel}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  card: {
    borderWidth: 1,
    borderColor: alpha.line,
    borderRadius: radius.lg,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  play: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playGlyph: { fontFamily: font.body, fontSize: 11 },
  wave: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 20,
  },
  time: { fontFamily: font.body, fontSize: 10.5 },
});
