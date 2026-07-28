import { useEffect } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Polygon } from 'react-native-svg';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** How far the pin drives inward, in points. */
const JAB_DISTANCE = 10;
const AMBIENT_DISTANCE = 2.4;

/**
 * The badge sits at the upper-right of the face, so the circle's centre lies
 * down and to the left — a unit vector of (-1, +1) normalised.
 */
const DIRECTION = { x: -Math.SQRT1_2, y: Math.SQRT1_2 };

export interface PinBadgeProps {
  onPress: () => void;
  size: number;
  /** Each badge gets a different phase so the arc never breathes in unison. */
  ambientDelayMs: number;
}

/**
 * The pin that appears over each face in pop mode.
 *
 * Tapping it drives the pin inward toward the centre of the portrait and back
 * out — the balloon bursts at the end of the inward stroke, so the pin is seen
 * to actually make contact rather than the face simply vanishing under it.
 *
 * It sits at the upper-right so it never covers the eyes, and carries its own
 * hit area; the reference's pin was easy to miss under a real thumb.
 */
export function PinBadge({ onPress, size, ambientDelayMs }: PinBadgeProps) {
  const badge = Math.max(22, size * 0.44);
  const jab = useSharedValue(0);
  const ambient = useSharedValue(-1);

  useEffect(() => {
    ambient.value = withDelay(
      ambientDelayMs,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 2800, easing: Easing.inOut(Easing.sin) }),
          withTiming(-1, { duration: 2800, easing: Easing.inOut(Easing.sin) })
        ),
        -1
      )
    );
  }, [ambient, ambientDelayMs]);

  const strike = () => {
    jab.value = withSequence(
      // In: fast and accelerating, like a thrust.
      withTiming(
        1,
        { duration: 75, easing: Easing.in(Easing.quad) },
        (finished) => {
          // Burst on contact, not on touch-down.
          if (finished) runOnJS(onPress)();
        }
      ),
      // Out: the recoil. Plays only if the face is still around to show it.
      withTiming(0, { duration: 150, easing: Easing.out(Easing.quad) })
    );
  };

  const style = useAnimatedStyle(() => ({
    transform: [
      {
        translateX:
          DIRECTION.x * (JAB_DISTANCE * jab.value + AMBIENT_DISTANCE * ambient.value),
      },
      {
        translateY:
          DIRECTION.y * (JAB_DISTANCE * jab.value + AMBIENT_DISTANCE * ambient.value),
      },
      // A touch of shrink on the way in adds weight to the thrust.
      { scale: 1 - 0.12 * jab.value },
    ],
  }));

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel="Let this introduction go"
      onPress={strike}
      hitSlop={10}
      style={[
        styles.badge,
        { width: badge, height: badge, borderRadius: badge / 2 },
        style,
      ]}
    >
      <Svg viewBox="0 0 100 100" width={badge * 0.7} height={badge * 0.7}>
        <Polygon points="53,38 60,45 20,95 15,90" fill="#141414" />
        <Circle cx="66" cy="26" r="20" fill="#CB4242" />
      </Svg>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: -6,
    right: -6,
    backgroundColor: 'rgba(252,252,251,0.96)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0A0A0A',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
});
