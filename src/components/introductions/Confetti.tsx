import { useEffect } from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

const PIECE_COUNT = 30;
const COLORS = ['#C5A054', '#D6B469', '#0A0A0A', '#9C9891', '#EDEBE6'];

/**
 * The match-reveal confetti. Falls once and stops — no loop, because a looping
 * celebration turns a moment into a slot machine.
 */
export function Confetti() {
  const { width, height } = Dimensions.get('window');

  const pieces = Array.from({ length: PIECE_COUNT }, (_, i) => ({
    x: ((i * 37) % 100) / 100,
    delay: (i % 8) * 90,
    duration: 2200 + (i % 5) * 260,
    size: 5 + (i % 3) * 3,
    color: COLORS[i % COLORS.length]!,
    spin: (i % 2 === 0 ? 1 : -1) * (240 + (i % 4) * 40),
  }));

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {pieces.map((piece, index) => (
        <Piece key={index} {...piece} left={piece.x * width} fall={height} />
      ))}
    </View>
  );
}

interface PieceProps {
  left: number;
  fall: number;
  delay: number;
  duration: number;
  size: number;
  color: string;
  spin: number;
}

function Piece({ left, fall, delay, duration, size, color, spin }: PieceProps) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withDelay(
      delay,
      withTiming(1, { duration, easing: Easing.linear })
    );
  }, [delay, duration, progress]);

  const style = useAnimatedStyle(() => ({
    opacity: 1 - progress.value,
    transform: [
      { translateY: progress.value * fall },
      { rotateZ: `${progress.value * spin}deg` },
    ],
  }));

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left,
          top: -20,
          width: size,
          height: size * 1.6,
          borderRadius: 1,
          backgroundColor: color,
        },
        style,
      ]}
    />
  );
}
