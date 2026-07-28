import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

const PARTICLE_COUNT = 22;

/**
 * Pre-computed particle field. Deterministic — the same burst every time keeps
 * the moment feeling like part of the product rather than a random effect.
 */
const PARTICLES = Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
  angle: (i * (360 / PARTICLE_COUNT) + (i % 3) * 5) * (Math.PI / 180),
  size: [7, 5, 4, 6][i % 4] ?? 5,
  duration: (0.3 + (i % 5) * 0.05) * 1000,
  distance: 26 + (i % 4) * 11,
  color: ['#9C9891', '#6E6B66', '#C9C5BE', '#4E4C48'][i % 4] ?? '#6E6B66',
}));

export interface PopBurstProps {
  /**
   * Where the released face was, in the strip's own coordinate space: `x` is
   * offset from the strip's horizontal centre, `y` from its top.
   */
  origin: { x: number; y: number };
  onComplete: () => void;
}

/**
 * The puff of particles when an introduction is let go.
 *
 * Rendered inside the arc strip rather than the screen, so it inherits the same
 * coordinate space the carousel already computes. That avoids a measurement
 * pass and — more importantly — guarantees it fires from the face that popped.
 */
export function PopBurst({ origin, onComplete }: PopBurstProps) {
  useEffect(() => {
    const timer = setTimeout(onComplete, 620);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.field,
        { transform: [{ translateX: origin.x }, { translateY: origin.y }] },
      ]}
    >
      {PARTICLES.map((particle, index) => (
        <Particle key={index} {...particle} />
      ))}
    </Animated.View>
  );
}

function Particle({
  angle,
  size,
  duration,
  distance,
  color,
}: (typeof PARTICLES)[number]) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(1, {
      duration,
      easing: Easing.bezier(0.15, 0.75, 0.3, 1),
    });
  }, [duration, progress]);

  const style = useAnimatedStyle(() => ({
    opacity: 1 - progress.value,
    transform: [
      { translateX: Math.cos(angle) * distance * progress.value },
      { translateY: Math.sin(angle) * distance * progress.value },
      { scale: 1 - 0.85 * progress.value },
    ],
  }));

  return (
    <Animated.View
      style={[
        styles.particle,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          marginLeft: -size / 2,
          marginTop: -size / 2,
          backgroundColor: color,
        },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  field: {
    position: 'absolute',
    left: '50%',
    top: 0,
    width: 0,
    height: 0,
    zIndex: 200,
  },
  particle: { position: 'absolute', left: 0, top: 0 },
});
