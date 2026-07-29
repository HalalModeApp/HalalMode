import { Image } from 'expo-image';
import { memo, useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  withSpring,
} from 'react-native-reanimated';

import { ChosenSparkles } from '@/components/introductions/ChosenSparkles';
import { PinBadge } from '@/components/introductions/PinBadge';
import { PopBurst } from '@/components/introductions/PopBurst';
import { ShineWipe } from '@/components/introductions/ShineWipe';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useI18n } from '@/i18n';
import { computeArcLayout as computeArcLayoutCore } from '@/lib/arcLayout';
import { alpha, color, motion } from '@/theme/tokens';
import type { Introduction } from '@/types';

const ARC_BUTTON = 52;

export interface ArcSlot {
  introduction: Introduction;
  x: number;
  y: number;
  /** Radians. Faces rotate with the arc; the frame counter-rotates. */
  angle: number;
  scale: number;
  opacity: number;
  zIndex: number;
  isActive: boolean;
  size: number;
}

/**
 * Lays the live introductions out along a shallow arc beneath the hero card,
 * or — once the set is larger than five — across two centred rows.
 *
 * This is the geometry from the reference prototype, extracted so it can be
 * unit-tested and reused by the Premium layout without duplication.
 */
export function computeArcLayout(
  live: Introduction[],
  activeId: string
): { slots: ArcSlot[]; isGrid: boolean; stripHeight: number } {
  return computeArcLayoutCore(live, activeId);
}


export interface ArcCarouselProps {
  live: Introduction[];
  activeId: string;
  /** Pop mode is on — tapping a face releases it instead of centring it. */
  popMode: boolean;
  /** True once the set is down to the keepable few; adds the gold glow. */
  chosenZone: boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onSendInterest: (id: string) => void;
  onRelease: (id: string) => void;
}

export function ArcCarousel({
  live,
  activeId,
  popMode,
  chosenZone,
  onSelect,
  onOpen,
  onSendInterest,
  onRelease,
}: ArcCarouselProps) {
  const reducedMotion = useReducedMotion();
  const { slots, isGrid, stripHeight } = useMemo(
    () => computeArcLayout(live, activeId),
    [live, activeId]
  );

  const baseTop = isGrid ? slots[0]?.size ?? ARC_BUTTON : ARC_BUTTON * 0.62;
  const top = baseTop + (isGrid ? 30 : 9);

  // Each burst is keyed so rapid pops queue up as separate fields rather than
  // restarting one shared animation.
  const [bursts, setBursts] = useState<
    { key: number; x: number; y: number }[]
  >([]);

  const handleRelease = useCallback(
    (id: string) => {
      // The slot's own geometry is the burst origin — no measurement needed,
      // and it stays correct even though the face is about to be removed.
      const slot = slots.find((item) => item.introduction.id === id);
      if (slot) {
        setBursts((current) => [
          ...current,
          { key: Date.now(), x: slot.x, y: top + slot.y },
        ]);
      }
      onRelease(id);
    },
    [slots, top, onRelease]
  );

  const clearBurst = useCallback((key: number) => {
    setBursts((current) => current.filter((burst) => burst.key !== key));
  }, []);

  return (
    <View style={[styles.strip, { height: stripHeight }]}>
      {slots.map((slot, index) => (
        <ArcFace
          key={slot.introduction.id}
          slot={slot}
          top={top}
          popMode={popMode}
          chosenZone={chosenZone}
          canRelease={live.length > 1}
          pinAmbientDelayMs={(index * 620 + slot.introduction.id.length * 80) % 2400}
          reducedMotion={reducedMotion}
          onSelect={onSelect}
          onOpen={onOpen}
          onSendInterest={onSendInterest}
          onRelease={handleRelease}
        />
      ))}

      {bursts.map((burst) => (
        <PopBurst
          key={burst.key}
          origin={{ x: burst.x, y: burst.y }}
          reducedMotion={reducedMotion}
          onComplete={() => clearBurst(burst.key)}
        />
      ))}
    </View>
  );
}

interface ArcFaceProps {
  slot: ArcSlot;
  top: number;
  popMode: boolean;
  chosenZone: boolean;
  canRelease: boolean;
  pinAmbientDelayMs: number;
  reducedMotion: boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onSendInterest: (id: string) => void;
  onRelease: (id: string) => void;
}

const ArcFace = memo(function ArcFace({
  slot,
  top,
  popMode,
  chosenZone,
  canRelease,
  pinAmbientDelayMs,
  reducedMotion,
  onSelect,
  onOpen,
  onSendInterest,
  onRelease,
}: ArcFaceProps) {
  const { t } = useI18n();
  const { introduction, isActive, size } = slot;
  const photo = introduction.profile.photos[0];

  const x = useDerivedValue(
    () => reducedMotion ? slot.x : withSpring(slot.x, motion.arc),
    [reducedMotion, slot.x]
  );
  const y = useDerivedValue(
    () => reducedMotion ? slot.y : withSpring(slot.y, motion.arc),
    [reducedMotion, slot.y]
  );
  const scale = useDerivedValue(
    () => reducedMotion ? slot.scale : withSpring(slot.scale, motion.arc),
    [reducedMotion, slot.scale]
  );
  const rotate = useDerivedValue(
    () => reducedMotion ? slot.angle : withSpring(slot.angle, motion.arc),
    [reducedMotion, slot.angle]
  );

  const wrapStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { translateY: y.value },
      { rotateZ: `${rotate.value}rad` },
      { scale: scale.value },
    ],
  }));

  const frameStyle = useAnimatedStyle(() => ({
    // Counter-rotate so the face stays upright while its slot swings.
    transform: [{ rotateZ: `${-rotate.value}rad` }],
  }));

  const handlePress = () => {
    if (popMode && canRelease) {
      onRelease(introduction.id);
      return;
    }
    if (chosenZone) {
      onSendInterest(introduction.id);
      return;
    }
    if (isActive) onOpen(introduction.id);
    else onSelect(introduction.id);
  };

  return (
    <Animated.View
      style={[
        styles.slot,
        {
          top,
          width: size,
          height: size,
          marginLeft: -size / 2,
          marginTop: -size / 2,
          opacity: slot.opacity,
          zIndex: slot.zIndex,
        },
        wrapStyle,
      ]}
      pointerEvents={slot.opacity < 0.2 ? 'none' : 'auto'}
    >
      <Animated.View style={[styles.frameWrap, frameStyle]}>
        {chosenZone ? (
          <ChosenSparkles
            size={size}
            seed={introduction.id}
            reducedMotion={reducedMotion}
          />
        ) : null}

        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={
            isActive
              ? t('daily.openProfileA11y', { name: introduction.profile.firstName })
              : t('daily.centerProfileA11y', { name: introduction.profile.firstName })
          }
          onPress={handlePress}
          style={[
            styles.frame,
            isActive ? styles.frameActive : styles.frameIdle,
            chosenZone && styles.frameChosen,
          ]}
        >
          <Image
            source={photo}
            style={styles.photo}
            contentFit="cover"
            transition={200}
            accessibilityIgnoresInvertColors
          />
          {/* Idle faces desaturate so the centred one owns the eye. */}
          {!isActive ? <View style={styles.desaturate} /> : null}

          {/* Inside the frame, so the band clips to the circle. */}
          {chosenZone ? (
            <ShineWipe size={size} reducedMotion={reducedMotion} />
          ) : null}
        </Pressable>

        {popMode && canRelease ? (
          <PinBadge
            onPress={() => onRelease(introduction.id)}
            size={size}
            ambientDelayMs={pinAmbientDelayMs}
            reducedMotion={reducedMotion}
          />
        ) : null}
      </Animated.View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  /**
   * Visible, not hidden: the pop burst and the chosen-one sparkles both radiate
   * past the strip's bounds, and clipping them cuts the effect in half. Faces
   * far along the arc fade to zero opacity anyway, so nothing spills.
   */
  strip: { position: 'relative', overflow: 'visible', marginTop: 2 },
  slot: { position: 'absolute', left: '50%' },
  frameWrap: { width: '100%', height: '100%' },
  frame: {
    width: '100%',
    height: '100%',
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: color.sandDeep,
  },
  frameIdle: { borderWidth: 1, borderColor: alpha.lineStrong },
  frameActive: {
    borderWidth: 2,
    borderColor: color.ink,
    shadowColor: '#0A0A0A',
    shadowOpacity: 0.32,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  frameChosen: {
    borderWidth: 2,
    borderColor: 'rgba(197,160,84,0.9)',
    shadowColor: '#C5A054',
    shadowOpacity: 0.75,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 10,
  },
  photo: { width: '100%', height: '100%' },
  /**
   * RN has no `filter: saturate()`, so a warm scrim stands in. It reads the same
   * at this size: the idle faces recede without going grey and lifeless.
   */
  desaturate: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(239,238,235,0.42)',
  },
});
