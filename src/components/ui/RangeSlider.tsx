import { useCallback, useEffect, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

import { alpha, color, radius } from '@/theme/tokens';

const THUMB = 22;
const TRACK_HEIGHT = 3;

export interface RangeSliderProps {
  min: number;
  max: number;
  step?: number;
  /** Current [low, high]. The component keeps low <= high itself. */
  value: [number, number];
  onChange: (value: [number, number]) => void;
}

/**
 * Dual-thumb slider for the private height range.
 *
 * The reference used two overlapping native `input[type=range]` elements, which
 * lets the thumbs cross over each other. Here they clamp against one another so
 * the range can never invert — a real bug in the prototype.
 */
export function RangeSlider({
  min,
  max,
  step = 1,
  value,
  onChange,
}: RangeSliderProps) {
  const [width, setWidth] = useState(0);
  const usable = Math.max(width - THUMB, 1);

  const lowValue = useSharedValue(value[0]);
  const highValue = useSharedValue(value[1]);
  const dragging = useSharedValue<'low' | 'high' | null>(null);

  // Sync props into the shared values between drags. This has to be an effect —
  // reading or writing a shared value during render is an error in Reanimated 4.
  useEffect(() => {
    if (dragging.value !== null) return;
    lowValue.value = value[0];
    highValue.value = value[1];
  }, [value, lowValue, highValue, dragging]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);

  const commit = useCallback(
    (low: number, high: number) => {
      onChange([low, high]);
    },
    [onChange]
  );

  const pan = Gesture.Pan()
    .minDistance(0)
    .onBegin((event) => {
      'worklet';
      const span = max - min || 1;
      const lowX = ((lowValue.value - min) / span) * usable;
      const highX = ((highValue.value - min) / span) * usable;
      const x = event.x - THUMB / 2;
      dragging.value = Math.abs(x - lowX) <= Math.abs(x - highX) ? 'low' : 'high';
    })
    .onUpdate((event) => {
      'worklet';
      const span = max - min || 1;
      const ratio = Math.min(1, Math.max(0, (event.x - THUMB / 2) / usable));
      const raw = min + ratio * span;
      const snapped = Math.round(raw / step) * step;
      const clamped = Math.min(max, Math.max(min, snapped));

      if (dragging.value === 'low') {
        lowValue.value = Math.min(clamped, highValue.value);
      } else {
        highValue.value = Math.max(clamped, lowValue.value);
      }
      runOnJS(commit)(lowValue.value, highValue.value);
    })
    .onFinalize(() => {
      'worklet';
      dragging.value = null;
    });

  const lowStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: ((lowValue.value - min) / (max - min || 1)) * usable },
    ],
  }));

  const highStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: ((highValue.value - min) / (max - min || 1)) * usable },
    ],
  }));

  const fillStyle = useAnimatedStyle(() => {
    const span = max - min || 1;
    const start = ((lowValue.value - min) / span) * usable;
    const end = ((highValue.value - min) / span) * usable;
    return { left: start + THUMB / 2, width: Math.max(0, end - start) };
  });

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.hitArea} onLayout={onLayout}>
        <View style={styles.track} />
        <Animated.View style={[styles.fill, fillStyle]} />
        <Animated.View
          style={[styles.thumb, lowStyle]}
          accessibilityRole="adjustable"
          accessibilityLabel="Minimum height"
          accessibilityValue={{ min, max, now: value[0] }}
        />
        <Animated.View
          style={[styles.thumb, highStyle]}
          accessibilityRole="adjustable"
          accessibilityLabel="Maximum height"
          accessibilityValue={{ min, max, now: value[1] }}
        />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  hitArea: { height: 40, justifyContent: 'center' },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: radius.pill,
    backgroundColor: alpha.lineStrong,
    marginHorizontal: THUMB / 2,
  },
  fill: {
    position: 'absolute',
    height: TRACK_HEIGHT,
    borderRadius: radius.pill,
    backgroundColor: color.ink,
  },
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: color.surface,
    borderWidth: 2,
    borderColor: color.ink,
    shadowColor: '#0A0A0A',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
});
