import { LinearGradient } from 'expo-linear-gradient';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

/**
 * A band of light sweeping diagonally across the chosen portrait.
 *
 * Straight from the reference's `shinewipe` keyframe. It is rendered inside the
 * frame, which already clips to a circle, so the band appears to travel under
 * the glass rather than over the top of it.
 */
export function ShineWipe({ size }: { size: number }) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.ease) }),
      -1,
      false
    );
  }, [progress]);

  const style = useAnimatedStyle(() => ({
    transform: [
      // Starts well off the left edge and finishes well off the right, so the
      // band is never parked mid-face between cycles.
      { translateX: -size * 1.4 + progress.value * size * 2.8 },
      { rotateZ: '18deg' },
    ],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.band,
        { width: size * 0.38, height: size * 1.9, top: -size * 0.45 },
        style,
      ]}
    >
      <LinearGradient
        colors={['transparent', 'rgba(255,246,220,0.9)', 'transparent']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  band: { position: 'absolute', left: 0 },
});
