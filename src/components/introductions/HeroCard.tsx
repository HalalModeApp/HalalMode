import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

import { Text } from '@/components/ui/Text';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useI18n } from '@/i18n';
import { color, radius } from '@/theme/tokens';
import type { Profile } from '@/types';

export interface HeroCardProps {
  profiles: Profile[];
  activeId: string;
  /** Shown on the currently centred card while Pop mode is active. */
  popMode: boolean;
  chosen: boolean;
  onPress: () => void;
  onSwipe: (direction: 'previous' | 'next') => void;
}

/**
 * A continuous circular deck. Every profile stays mounted for the entire
 * gesture, so no image source or card layer is swapped at the handoff point.
 * This is what prevents the one-frame flash caused by a front/back card swap.
 */
export function HeroCard({
  profiles,
  activeId,
  popMode,
  chosen,
  onPress,
  onSwipe,
}: HeroCardProps) {
  const reducedMotion = useReducedMotion();
  const { width } = useWindowDimensions();
  const cardWidth = width - 60;
  const activeIndex = Math.max(0, profiles.findIndex((profile) => profile.id === activeId));
  const centerIndex = useSharedValue(activeIndex);
  const dragStart = useSharedValue(activeIndex);
  const handoffInProgress = useRef(false);

  const commitSwipe = (direction: 'previous' | 'next') => {
    // The parent moves the icon arc immediately. The card deck continues on
    // its current shared-value trajectory rather than resetting to that icon.
    handoffInProgress.current = true;
    onSwipe(direction);
  };

  // Icon taps can select a new card outside this gesture. A completed swipe
  // already points to the same index modulo the number of cards, so it needs
  // no reset and therefore has no visible handoff frame.
  useLayoutEffect(() => {
    if (handoffInProgress.current) {
      handoffInProgress.current = false;
      return;
    }
    const current = Math.round(centerIndex.value);
    const normalized = ((current % profiles.length) + profiles.length) % profiles.length;
    if (normalized !== activeIndex) {
      let offset = activeIndex - normalized;
      if (offset > profiles.length / 2) offset -= profiles.length;
      if (offset < -profiles.length / 2) offset += profiles.length;
      const target = current + offset;
      centerIndex.value = reducedMotion
        ? target
        : withSpring(target, {
            damping: 18,
            stiffness: 165,
            mass: 0.8,
          });
    }
  }, [activeIndex, centerIndex, profiles.length, reducedMotion]);

  const swipe = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-20, 20])
    .onBegin(() => {
      dragStart.value = Math.round(centerIndex.value);
    })
    .onUpdate((event) => {
      centerIndex.value = dragStart.value - event.translationX / cardWidth;
    })
    .onEnd((event) => {
      const direction = event.translationX < -56 ? 'next' : event.translationX > 56 ? 'previous' : null;
      const target = dragStart.value + (direction === 'next' ? 1 : direction === 'previous' ? -1 : 0);
      if (direction) runOnJS(commitSwipe)(direction);
      centerIndex.value = reducedMotion
        ? target
        : withSpring(target, {
            damping: direction ? 17 : 20,
            stiffness: direction ? 155 : 180,
            mass: 0.8,
          });
    });

  return (
    <GestureDetector gesture={swipe}>
      <View style={styles.deck}>
        {profiles.map((profile, index) => (
          <DeckCard
            key={profile.id}
            profile={profile}
            index={index}
            count={profiles.length}
            cardWidth={cardWidth}
            centerIndex={centerIndex}
            isActive={profile.id === activeId}
            popMode={popMode}
            chosen={chosen}
            reducedMotion={reducedMotion}
            onPress={onPress}
          />
        ))}
      </View>
    </GestureDetector>
  );
}

interface DeckCardProps {
  profile: Profile;
  index: number;
  count: number;
  cardWidth: number;
  centerIndex: SharedValue<number>;
  isActive: boolean;
  popMode: boolean;
  chosen: boolean;
  reducedMotion: boolean;
  onPress: () => void;
}

function DeckCard({
  profile,
  index,
  count,
  cardWidth,
  centerIndex,
  isActive,
  popMode,
  chosen,
  reducedMotion,
  onPress,
}: DeckCardProps) {
  const { t, isRTL } = useI18n();
  const pivotDepth = Math.max(cardWidth * 2.7, 780);
  const settleScale = useSharedValue(1);

  useEffect(() => {
    if (!isActive) return;
    if (reducedMotion) {
      settleScale.value = 1;
      return;
    }
    settleScale.value = withSequence(
      withSpring(1.018, { damping: 16, stiffness: 240, mass: 0.55 }),
      withSpring(1, { damping: 16, stiffness: 190, mass: 0.65 })
    );
  }, [isActive, reducedMotion, settleScale]);

  const cardStyle = useAnimatedStyle(() => {
    const centre = ((centerIndex.value % count) + count) % count;
    let relative = index - centre;
    if (relative > count / 2) relative -= count;
    if (relative < -count / 2) relative += count;

    const distance = Math.abs(relative);
    const horizontal = relative * cardWidth;
    const arcAngle = Math.asin(
      Math.max(-0.72, Math.min(0.72, horizontal / pivotDepth))
    );

    // Cards waiting at either edge are a touch smaller. They grow to full
    // size continuously as their circular path brings them to the centre.
    const scale = 1 - Math.min(distance, 1) * 0.07;
    const opacity = Math.max(0, 1 - Math.max(0, distance - 0.85) * 0.55);

    return {
      opacity,
      zIndex: Math.round(100 - distance * 10),
      transform: [
        { perspective: 900 },
        { translateY: pivotDepth },
        { rotateZ: `${arcAngle}rad` },
        { translateY: -pivotDepth },
        { rotateY: `${-arcAngle * 16}deg` },
        { scale: scale * settleScale.value },
      ],
    };
  });

  return (
    <Animated.View
      pointerEvents={isActive ? 'auto' : 'none'}
      style={[styles.card, isActive && chosen && styles.cardChosen, cardStyle]}
    >
      <Image
        source={profile.photos[0]}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        accessibilityIgnoresInvertColors
      />
      <LinearGradient
        pointerEvents="none"
        colors={['transparent', 'rgba(10,10,10,0.12)', 'rgba(10,10,10,0.72)']}
        locations={[0.32, 0.54, 1]}
        style={StyleSheet.absoluteFill}
      />
      {isActive ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('daily.openProfileA11y', { name: profile.firstName })}
          onPress={onPress}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View style={[styles.caption, isRTL && styles.rtl]} pointerEvents="none">
        <Text style={styles.name}>{profile.name}</Text>
        <Text style={styles.line}>
          {profile.age} · {profile.city} · {profile.occupation}
        </Text>
      </View>
      {isActive && popMode ? (
        <View style={styles.popBadge} pointerEvents="none">
          <Text style={styles.popBadgeLabel}>{t('daily.popLabel')}</Text>
        </View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  rtl: { direction: 'rtl' },
  deck: {
    flex: 1,
    marginHorizontal: 30,
    overflow: 'visible',
  },
  card: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: radius.hero,
    overflow: 'hidden',
    backgroundColor: color.clay,
    shadowColor: '#0A0A0A',
    shadowOpacity: 0.2,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 12 },
    elevation: 7,
  },
  cardChosen: {
    shadowColor: '#C5A054',
    shadowOpacity: 0.7,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
  caption: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 22,
    paddingBottom: 16,
    alignItems: 'center',
  },
  name: {
    fontFamily: 'PlayfairDisplay_400Regular',
    fontSize: 24,
    lineHeight: 28,
    color: color.white,
    textAlign: 'center',
  },
  line: {
    fontFamily: 'Beiruti_400Regular',
    fontSize: 11.5,
    color: 'rgba(252,252,251,0.78)',
    marginTop: 4,
    textAlign: 'center',
  },
  popBadge: {
    position: 'absolute',
    top: 14,
    left: 14,
    backgroundColor: 'rgba(252,252,251,0.94)',
    borderRadius: radius.pill,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  popBadgeLabel: {
    fontFamily: 'Beiruti_700Bold',
    fontSize: 9.5,
    letterSpacing: 1.7,
    textTransform: 'uppercase',
    color: color.ink,
  },
});
