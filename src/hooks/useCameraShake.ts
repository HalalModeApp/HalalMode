import { useCallback } from 'react';
import {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

/**
 * Keyframes transcribed from the reference's `shakecam`, including its uneven
 * timing. The irregularity is the point — evenly spaced steps read as a
 * vibration, while these read as a knock the camera is recovering from.
 */
const STEPS: { x: number; y: number; duration: number }[] = [
  { x: -3, y: 2, duration: 51 },
  { x: 3, y: -2, duration: 51 },
  { x: -2, y: -1, duration: 51 },
  { x: 2, y: 1, duration: 51 },
  { x: -1, y: 0, duration: 68 },
  { x: 0, y: 0, duration: 68 },
];

/**
 * A short, subtle camera knock.
 *
 * Peaks at three pixels. Anything larger stops reading as a camera and starts
 * reading as the layout breaking — and this fires on every pop, so it has to
 * survive being seen four times in a row without becoming annoying.
 */
// The style's type is inferred from `useAnimatedStyle` rather than annotated —
// Reanimated's exported `AnimatedStyle` is wider than what `View` accepts.
export function useCameraShake() {
  const x = useSharedValue(0);
  const y = useSharedValue(0);

  const shake = useCallback(() => {
    const linear = { easing: Easing.linear };
    x.value = withSequence(
      withTiming(STEPS[0]!.x, { ...linear, duration: STEPS[0]!.duration }),
      withTiming(STEPS[1]!.x, { ...linear, duration: STEPS[1]!.duration }),
      withTiming(STEPS[2]!.x, { ...linear, duration: STEPS[2]!.duration }),
      withTiming(STEPS[3]!.x, { ...linear, duration: STEPS[3]!.duration }),
      withTiming(STEPS[4]!.x, { ...linear, duration: STEPS[4]!.duration }),
      withTiming(STEPS[5]!.x, { ...linear, duration: STEPS[5]!.duration })
    );
    y.value = withSequence(
      withTiming(STEPS[0]!.y, { ...linear, duration: STEPS[0]!.duration }),
      withTiming(STEPS[1]!.y, { ...linear, duration: STEPS[1]!.duration }),
      withTiming(STEPS[2]!.y, { ...linear, duration: STEPS[2]!.duration }),
      withTiming(STEPS[3]!.y, { ...linear, duration: STEPS[3]!.duration }),
      withTiming(STEPS[4]!.y, { ...linear, duration: STEPS[4]!.duration }),
      withTiming(STEPS[5]!.y, { ...linear, duration: STEPS[5]!.duration })
    );
  }, [x, y]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }],
  }));

  return { shake, style };
}
