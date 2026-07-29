import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/Text';
import { useI18n } from '@/i18n';
import { color, font, motion, radius } from '@/theme/tokens';

const RAIL_HEIGHT = 62;

/** Each tab's glyph. The reference used these three marks in place of icons. */
const MARKS: Record<string, string> = {
  daily: '✦',
  connections: '♥',
  you: '✿',
};

/**
 * Floating navigation rail.
 *
 * The reference achieved its soft, liquid pill with an SVG `feGaussianBlur` goo
 * filter, which has no React Native equivalent. A sprung indicator pill under a
 * translucent rail lands in the same place visually and costs nothing per frame.
 */
export function TabBar({ state, navigation }: BottomTabBarProps) {
  const { t, isRTL } = useI18n();
  const insets = useSafeAreaInsets();
  const railWidth = useSharedValue(0);
  const index = useSharedValue(state.index);

  // Must be an effect, not a render-time assignment. Reanimated 4 treats
  // writing to a shared value during render as an error.
  useEffect(() => {
    index.value = withSpring(state.index, motion.arc);
  }, [state.index, index]);

  const count = state.routes.length;

  const pillStyle = useAnimatedStyle(() => {
    const slot = railWidth.value / count;
    return {
      width: slot - 14,
      transform: [{ translateX: (isRTL ? count - 1 - index.value : index.value) * slot + 7 }],
    };
  });

  return (
    <View style={[styles.wrap, { paddingBottom: insets.bottom }]} pointerEvents="box-none">
      <LinearGradient
        colors={['rgba(252,252,251,0)', 'rgba(173,173,173,0.55)']}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      <View
        style={[styles.rail, isRTL && styles.rowReverse]}
        onLayout={(event) => {
          railWidth.value = event.nativeEvent.layout.width;
        }}
      >
        <Animated.View style={[styles.pill, pillStyle]} pointerEvents="none" />

        {state.routes.map((route, routeIndex) => {
          const focused = state.index === routeIndex;

          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={tabLabel(route.name, t)}
              style={[styles.tab, isRTL && styles.rowReverse]}
              onPress={() => {
                const event = navigation.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true,
                });
                if (focused || event.defaultPrevented) return;
                void Haptics.selectionAsync();
                navigation.navigate(route.name);
              }}
            >
              <Text style={[styles.mark, focused && styles.markActive]}>
                {MARKS[route.name] ?? '•'}
              </Text>
              <Text style={[styles.label, focused && styles.labelActive]}>
                {tabLabel(route.name, t)}
              </Text>
            </Pressable>
          );
        })}
      </View>

    </View>
  );
}

function tabLabel(name: string, t: ReturnType<typeof useI18n>['t']): string {
  if (name === 'daily') return t('nav.daily');
  if (name === 'connections') return t('nav.connections');
  if (name === 'you') return t('nav.you');
  return name;
}

const styles = StyleSheet.create({
  rowReverse: { flexDirection: 'row-reverse' },
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 12,
  },
  rail: {
    height: RAIL_HEIGHT,
    marginHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(252,252,251,0.92)',
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#0A0A0A',
    shadowOpacity: 0.14,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },
  pill: {
    position: 'absolute',
    top: 7,
    bottom: 7,
    borderRadius: radius.pill,
    backgroundColor: color.sand,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: '100%',
  },
  mark: { fontFamily: font.body, fontSize: 11, color: color.whisper },
  markActive: { color: color.gold },
  label: {
    fontFamily: font.body,
    fontSize: 11,
    letterSpacing: 0.4,
    color: color.faint,
  },
  labelActive: { fontFamily: font.bodySemi, color: color.ink },
});
