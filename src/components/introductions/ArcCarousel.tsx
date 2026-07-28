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
import { alpha, color, motion } from '@/theme/tokens';
import type { Introduction } from '@/types';

/**
 * Angular gap between adjacent faces, in radians. Straight from the reference
 * (`DPSI = 0.30`) — small enough that the arc reads as a gentle curve rather
 * than a wheel.
 */
const DELTA_PSI = 0.3;

/** How far the arc is allowed to dip. Keeps the strip inside its 86px band. */
const Y_CAP = 16;

/** Face diameter and centre-to-centre spacing when the set fits on one arc. */
const ARC_BUTTON = 52;
const ARC_STEP = 72;

/** Width the strip may use before it wraps to the two-row grid. */
const AVAILABLE_WIDTH = 330;

/** Above this count the arc becomes unreadable, so Plus rounds go to a grid. */
const ARC_MAX = 5;

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
 * unit-tested and reused by the Plus layout without duplication.
 */
export function computeArcLayout(
  live: Introduction[],
  activeId: string
): { slots: ArcSlot[]; isGrid: boolean; stripHeight: number } {
  const count = live.length || 1;
  const isGrid = count > ARC_MAX;

  const perRow = isGrid ? Math.ceil(count / 2) : count;
  const step = isGrid ? Math.min(ARC_STEP, AVAILABLE_WIDTH / perRow) : ARC_STEP;
  const size = isGrid
    ? Math.max(34, Math.min(ARC_BUTTON, step * 0.72))
    : ARC_BUTTON;

  const radiusOfArc = step / (2 * Math.sin(DELTA_PSI / 2));
  const activeIndex = Math.max(
    0,
    live.findIndex((item) => item.id === activeId)
  );

  const slots: ArcSlot[] = live.map((introduction, index) => {
    const isActive = introduction.id === activeId;

    if (isGrid) {
      const row = Math.floor(index / perRow);
      const col = index % perRow;
      const rowCount = Math.min(perRow, count - row * perRow);
      const rows = Math.ceil(count / perRow);
      return {
        introduction,
        x: (col - (rowCount - 1) / 2) * step,
        y: row * step - ((rows - 1) * step) / 2,
        angle: 0,
        scale: 1,
        opacity: 1,
        zIndex: isActive ? 100 : 1,
        isActive,
        size,
      };
    }

    // Shortest-path slot offset, so the arc rotates the near way round.
    let slot = ((index - activeIndex) % count + count) % count;
    if (slot > count / 2) slot -= count;

    const angle = slot * DELTA_PSI;
    const distance = Math.abs(slot);
    const depth = Math.max(0, 1 - (0.5 * distance) / 2.4);
    const arcY = Math.min(radiusOfArc * (1 - Math.cos(angle)), Y_CAP);

    return {
      introduction,
      x: radiusOfArc * Math.sin(angle),
      // Lift the two neighbours of the centred face just enough to turn the
      // five-person layout into a gentle arch instead of a pointed chevron.
      y: distance === 1 ? Math.max(4, arcY - 5) : arcY,
      angle,
      scale: 0.62 + 0.38 * depth,
      opacity: distance <= 2 ? 1 : Math.max(0, 1 - (distance - 2)),
      zIndex: Math.round(depth * 100) + (isActive ? 100 : 0),
      isActive,
      size,
    };
  });

  return {
    slots,
    isGrid,
    stripHeight: isGrid ? size * 2 + 46 : 86,
  };
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
  onSelect,
  onOpen,
  onSendInterest,
  onRelease,
}: ArcFaceProps) {
  const { introduction, isActive, size } = slot;
  const photo = introduction.profile.photos[0];

  const x = useDerivedValue(() => withSpring(slot.x, motion.arc), [slot.x]);
  const y = useDerivedValue(() => withSpring(slot.y, motion.arc), [slot.y]);
  const scale = useDerivedValue(
    () => withSpring(slot.scale, motion.arc),
    [slot.scale]
  );
  const rotate = useDerivedValue(
    () => withSpring(slot.angle, motion.arc),
    [slot.angle]
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
          <ChosenSparkles size={size} seed={introduction.id} />
        ) : null}

        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={
            isActive
              ? `Open ${introduction.profile.firstName}'s profile`
              : `Bring ${introduction.profile.firstName} to the centre`
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
          {chosenZone ? <ShineWipe size={size} /> : null}
        </Pressable>

        {popMode && canRelease ? (
          <PinBadge
            onPress={() => onRelease(introduction.id)}
            size={size}
            ambientDelayMs={pinAmbientDelayMs}
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
