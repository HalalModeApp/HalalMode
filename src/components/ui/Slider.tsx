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

export interface SliderProps {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  accessibilityLabel: string;
}

/** Single-thumb slider — the "Nearby radius" control. */
export function Slider({
  min,
  max,
  step = 1,
  value,
  onChange,
  accessibilityLabel,
}: SliderProps) {
  const [width, setWidth] = useState(0);
  const usable = Math.max(width - THUMB, 1);

  const current = useSharedValue(value);
  const dragging = useSharedValue(false);

  // Effect, not render-time assignment — see RangeSlider for the reasoning.
  useEffect(() => {
    if (dragging.value) return;
    current.value = value;
  }, [value, current, dragging]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);

  const pan = Gesture.Pan()
    .minDistance(0)
    .onBegin(() => {
      'worklet';
      dragging.value = true;
    })
    .onUpdate((event) => {
      'worklet';
      const ratio = Math.min(1, Math.max(0, (event.x - THUMB / 2) / usable));
      const raw = min + ratio * (max - min);
      const snapped = Math.min(max, Math.max(min, Math.round(raw / step) * step));
      current.value = snapped;
      runOnJS(onChange)(snapped);
    })
    .onFinalize(() => {
      'worklet';
      dragging.value = false;
    });

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: ((current.value - min) / (max - min || 1)) * usable },
    ],
  }));

  const fillStyle = useAnimatedStyle(() => ({
    width: ((current.value - min) / (max - min || 1)) * usable + THUMB / 2,
  }));

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.hitArea} onLayout={onLayout}>
        <View style={styles.track} />
        <Animated.View style={[styles.fill, fillStyle]} />
        <Animated.View
          style={[styles.thumb, thumbStyle]}
          accessibilityRole="adjustable"
          accessibilityLabel={accessibilityLabel}
          accessibilityValue={{ min, max, now: value }}
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
    left: 0,
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
