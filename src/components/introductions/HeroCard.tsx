import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import { Gyroscope } from 'expo-sensors';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';
import {
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
} from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';

import { Text } from '@/components/ui/Text';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useI18n } from '@/i18n';
import { deckDirectionForAccessibilityAction } from '@/lib/roundInvariants';
import { testIds } from '@/lib/testIds';
import { color, radius } from '@/theme/tokens';
import type { Profile } from '@/types';

const RAD2DEG = 180 / Math.PI;

/**
 * Film-grain opacity on the centred card.
 */
const FILM_GRAIN_OPACITY = 0.06;

/**
 * Keeps the immediate left and right cards already visible and decoded before
 * either card becomes centred.
 */
const FILM_GRAIN_NEIGHBOUR_STRENGTH = 0.5;

/**
 * Maximum visible card tilt from the device gyroscope.
 */
const MAX_TILT_ANGLE = 12;

/**
 * How strongly rotational device movement affects the cards.
 */
const GYRO_SENSITIVITY = 0.2;

/**
 * Ignores tiny sensor fluctuations while the phone is stationary.
 */
const GYRO_DEAD_ZONE = 0.015;

/**
 * Prevents large jumps if the JavaScript thread briefly stalls.
 */
const MAX_DELTA_TIME = 0.05;

/**
 * Controls how quickly the gyroscope tilt returns toward zero.
 */
const RECENTER_TIME_SECONDS = 0.35;

/**
 * The full ring cannot turn farther than 100 degrees in either direction.
 */
const MAX_RING_YAW = 100;

/**
 * Short, fast reset.
 *
 * Combined with Easing.out(Easing.poly(4)), the ring moves back quickly
 * at the beginning and slows gently as it approaches zero.
 */
const RING_YAW_RECENTER_DURATION = 850;

function clamp(
  value: number,
  minimum: number,
  maximum: number,
) {
  'worklet';

  return Math.min(
    Math.max(value, minimum),
    maximum,
  );
}

function finiteOrZero(value: number) {
  'worklet';

  return Number.isFinite(value)
    ? value
    : 0;
}

/**
 * Consecutive rapid swipes in the same direction use:
 *
 * 1st swipe:  2 degrees
 * 2nd swipe:  4 degrees
 * 3rd swipe:  8 degrees
 * 4th swipe:  16 degrees
 * 5th+ swipe: 32 degrees
 */
function ringYawStepForIndex(index: number) {
  'worklet';

  if (index <= 0) {
    return 2;
  }

  if (index === 1) {
    return 4;
  }

  if (index === 2) {
    return 8;
  }

  if (index === 3) {
    return 16;
  }

  return 32;
}

export interface HeroCardProps {
  profiles: Profile[];
  activeId: string;

  /** Shown on the currently centred card while Pop mode is active. */
  popMode: boolean;

  chosen: boolean;

  /** Opens the exact profile physically centred in the deck. */
  onPress: (profileId: string) => void;

  /** Reports the exact profile selected by a completed swipe. */
  onSwipe: (profileId: string) => void;
}

/**
 * A continuous circular deck. Every profile stays mounted for the entire
 * gesture, so no image source or card layer is swapped at the handoff point.
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
  const { t } = useI18n();
  const { width } = useWindowDimensions();

  const cardWidth = Math.max(
    width - 60,
    1,
  );

  const foundActiveIndex = profiles.findIndex(
    (profile) => profile.id === activeId,
  );

  const activeIndex = Math.max(
    0,
    foundActiveIndex,
  );

  const activeProfile =
    profiles[activeIndex] ?? profiles[0];

  /** Fractional visual position while dragging and animating. */
  const centerIndex = useSharedValue(activeIndex);

  /**
   * Latest intended integer destination. It updates immediately when a swipe
   * completes, so another fast swipe starts from the intended card even if the
   * previous animation has not finished.
   */
  const committedIndex = useSharedValue(activeIndex);

  /** Visual and logical starting points for the current gesture. */
  const dragVisualStart = useSharedValue(activeIndex);
  const dragCommittedStart = useSharedValue(activeIndex);

  const tiltX = useSharedValue(0);
  const tiltY = useSharedValue(0);

  /**
   * Shared left/right facing angle of the complete card ring.
   */
  const ringYaw = useSharedValue(0);

  /**
   * Current position in the 2, 4, 8, 16, 32 sequence.
   */
  const ringMomentumIndex = useSharedValue(0);

  /**
   * 1 means the last swipe turned the ring right.
   * -1 means the last swipe turned the ring left.
   * 0 means there is no active momentum streak.
   */
  const lastRingDirection = useSharedValue(0);

  /**
   * While React is applying rapid swipe updates, an older activeId render can
   * briefly arrive before the newest one. Ignore that stale render rather than
   * pulling the visual deck backwards.
   */
  const pendingSwipeProfileId = useRef<string | null>(null);

  /**
   * Gyroscope-based transient tilt.
   *
   * Rotational movement adds tilt while exponential decay continuously
   * returns the cards toward zero.
   */
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      let subscription:
        | ReturnType<typeof Gyroscope.addListener>
        | null = null;

      let previousTime = Date.now();

      /**
       * Clear invalid values that may have survived Fast Refresh.
       */
      tiltX.value = 0;
      tiltY.value = 0;
      ringYaw.value = 0;
      ringMomentumIndex.value = 0;
      lastRingDirection.value = 0;

      const startGyroscope = async () => {
        try {
          const available =
            await Gyroscope.isAvailableAsync();

          if (!available || cancelled) {
            return;
          }

          Gyroscope.setUpdateInterval(16);
          previousTime = Date.now();

          subscription = Gyroscope.addListener(
            (measurement) => {
              const x = measurement?.x;
              const y = measurement?.y;

              /**
               * Never allow incomplete sensor values into a transform.
               */
              if (
                !Number.isFinite(x) ||
                !Number.isFinite(y)
              ) {
                tiltX.value = 0;
                tiltY.value = 0;
                previousTime = Date.now();
                return;
              }

              const currentTime = Date.now();

              const deltaTime = Math.min(
                Math.max(
                  (currentTime - previousTime) / 1000,
                  0,
                ),
                MAX_DELTA_TIME,
              );

              previousTime = currentTime;

              if (!Number.isFinite(deltaTime)) {
                tiltX.value = 0;
                tiltY.value = 0;
                return;
              }

              const cleanX =
                Math.abs(x) < GYRO_DEAD_ZONE
                  ? 0
                  : x;

              const cleanY =
                Math.abs(y) < GYRO_DEAD_ZONE
                  ? 0
                  : y;

              const movementX =
                cleanX *
                RAD2DEG *
                deltaTime *
                GYRO_SENSITIVITY;

              const movementY =
                -cleanY *
                RAD2DEG *
                deltaTime *
                GYRO_SENSITIVITY;

              const recenterMultiplier =
                Math.exp(
                  -deltaTime /
                    RECENTER_TIME_SECONDS,
                );

              const currentTiltX =
                Number.isFinite(tiltX.value)
                  ? tiltX.value
                  : 0;

              const currentTiltY =
                Number.isFinite(tiltY.value)
                  ? tiltY.value
                  : 0;

              const nextTiltX = clamp(
                (
                  currentTiltX +
                  movementX
                ) * recenterMultiplier,
                -MAX_TILT_ANGLE,
                MAX_TILT_ANGLE,
              );

              const nextTiltY = clamp(
                (
                  currentTiltY +
                  movementY
                ) * recenterMultiplier,
                -MAX_TILT_ANGLE,
                MAX_TILT_ANGLE,
              );

              tiltX.value =
                Number.isFinite(nextTiltX)
                  ? nextTiltX
                  : 0;

              tiltY.value =
                Number.isFinite(nextTiltY)
                  ? nextTiltY
                  : 0;
            },
          );
        } catch {
          tiltX.value = 0;
          tiltY.value = 0;
        }
      };

      void startGyroscope();

      return () => {
        cancelled = true;
        subscription?.remove();

        tiltX.value = withTiming(0, {
          duration: 300,
          easing: Easing.out(
            Easing.cubic,
          ),
        });

        tiltY.value = withTiming(0, {
          duration: 300,
          easing: Easing.out(
            Easing.cubic,
          ),
        });

        ringYaw.value = withTiming(
          0,
          {
            duration:
              RING_YAW_RECENTER_DURATION,
            easing: Easing.out(
              Easing.poly(4),
            ),
          },
          (finished) => {
            if (finished) {
              ringMomentumIndex.value = 0;
              lastRingDirection.value = 0;
            }
          },
        );
      };
    }, [
      lastRingDirection,
      ringMomentumIndex,
      ringYaw,
      tiltX,
      tiltY,
    ]),
  );

  /** Resolve an unbounded circular index to a profile ID on the JS thread. */
  const profileIdAtIndex = useCallback(
    (unboundedIndex: number) => {
      if (profiles.length === 0) return null;
      const normalized =
        ((unboundedIndex % profiles.length) + profiles.length) % profiles.length;
      return profiles[normalized]?.id ?? null;
    },
    [profiles]
  );

  /**
   * Called from the gesture worklet through runOnJS. The parent receives the
   * exact selected profile instead of recalculating from a possibly stale ID.
   */
  const commitSwipeToIndex = useCallback(
    (targetIndex: number) => {
      const profileId = profileIdAtIndex(targetIndex);
      if (!profileId) return;
      pendingSwipeProfileId.current = profileId;
      onSwipe(profileId);
    },
    [onSwipe, profileIdAtIndex]
  );

  /** Opens whichever card is physically centred when the tap completes. */
  const openCardAtIndex = useCallback(
    (targetIndex: number) => {
      const profileId = profileIdAtIndex(targetIndex);
      if (profileId) onPress(profileId);
    },
    [onPress, profileIdAtIndex]
  );

  /**
   * Circle-carousel taps and other external activeId changes still move the hero
   * deck. During rapid swipes, stale intermediate parent renders are ignored.
   */
  useLayoutEffect(() => {
    if (profiles.length === 0) {
      pendingSwipeProfileId.current = null;
      centerIndex.value = 0;
      committedIndex.value = 0;
      return;
    }

    const pendingProfileId = pendingSwipeProfileId.current;

    if (pendingProfileId) {
      if (activeId === pendingProfileId) {
        pendingSwipeProfileId.current = null;
      }
      // The deck already moved to the newest committed swipe destination.
      // Do not reconcile it to an older activeId render in between.
      return;
    }

    const current = Math.round(committedIndex.value);
    const normalized =
      ((current % profiles.length) + profiles.length) % profiles.length;

    if (normalized === activeIndex) return;

    let offset = activeIndex - normalized;

    if (offset > profiles.length / 2) offset -= profiles.length;
    if (offset < -profiles.length / 2) offset += profiles.length;

    const target = current + offset;
    committedIndex.value = target;
    cancelAnimation(centerIndex);
    centerIndex.value = reducedMotion
      ? target
      : withSpring(target, {
          damping: 18,
          stiffness: 165,
          mass: 0.8,
        });
  }, [
    activeId,
    activeIndex,
    centerIndex,
    committedIndex,
    profiles.length,
    reducedMotion,
  ]);

  /** Accessibility movement uses the same exact-index path as touch swipes. */
  const moveForAccessibility = useCallback(
    (direction: 'previous' | 'next') => {
      if (profiles.length < 2) return;
      const target =
        Math.round(committedIndex.value) + (direction === 'next' ? 1 : -1);

      committedIndex.value = target;
      cancelAnimation(centerIndex);
      centerIndex.value = reducedMotion
        ? target
        : withSequence(
            withTiming(target + (direction === 'next' ? 0.04 : -0.04), {
              duration: 220,
              easing: Easing.out(Easing.cubic),
            }),
            withSpring(target, {
              damping: 10,
              stiffness: 230,
              mass: 0.55,
              overshootClamping: false,
            })
          );

      commitSwipeToIndex(target);
    },
    [
      centerIndex,
      commitSwipeToIndex,
      committedIndex,
      profiles.length,
      reducedMotion,
    ]
  );

  const swipe = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-20, 20])
    .onBegin(() => {
      cancelAnimation(centerIndex);
      dragVisualStart.value = centerIndex.value;
      dragCommittedStart.value = Math.round(committedIndex.value);
    })
    .onUpdate((event) => {
      centerIndex.value =
        dragVisualStart.value -
        event.translationX / cardWidth;
    })
    .onEnd((event) => {
      const direction =
        event.translationX < -20
          ? 'next'
          : event.translationX > 20
            ? 'previous'
            : null;

      const target =
        dragCommittedStart.value +
        (direction === 'next'
          ? 1
          : direction === 'previous'
            ? -1
            : 0);

      if (direction) {
        // Commit immediately so another rapid swipe starts from this target.
        committedIndex.value = target;
        if (!reducedMotion) {
          /**
           * Freeze the current return animation at its current position.
           *
           * A fast additional swipe can therefore add more momentum.
           */
          cancelAnimation(ringYaw);

          const directionSign =
            direction === 'previous'
              ? 1
              : -1;

          const currentYaw = clamp(
            finiteOrZero(
              ringYaw.value,
            ),
            -MAX_RING_YAW,
            MAX_RING_YAW,
          );

          /**
           * Continue the sequence only when swiping rapidly in the same
           * direction while meaningful rotation still remains.
           */
          const continuingSameDirection =
            lastRingDirection.value ===
              directionSign &&
            Math.abs(currentYaw) > 0.25;

          const nextMomentumIndex =
            continuingSameDirection
              ? Math.min(
                  ringMomentumIndex.value + 1,
                  4,
                )
              : 0;

          const yawStep =
            ringYawStepForIndex(
              nextMomentumIndex,
            );

          /**
           * Changing direction starts a fresh 2-degree streak.
           *
           * It does not require several opposite swipes to overcome the
           * previous direction's remaining yaw.
           */
          const yawBeforeStep =
            Math.sign(currentYaw) ===
            directionSign
              ? currentYaw
              : 0;

          ringMomentumIndex.value =
            nextMomentumIndex;

          lastRingDirection.value =
            directionSign;

          ringYaw.value = clamp(
            yawBeforeStep +
              directionSign *
                yawStep,
            -MAX_RING_YAW,
            MAX_RING_YAW,
          );

          /**
           * Reset quickly at the beginning and gently near zero.
           *
           * A new swipe cancels this animation and preserves the streak.
           */
          ringYaw.value = withTiming(
            0,
            {
              duration:
                RING_YAW_RECENTER_DURATION,
              easing: Easing.out(
                Easing.poly(4),
              ),
            },
            (finished) => {
              if (finished) {
                ringMomentumIndex.value = 0;
                lastRingDirection.value = 0;
              }
            },
          );
        }

        runOnJS(commitSwipeToIndex)(
          target,
        );
      }

      if (reducedMotion) {
        centerIndex.value = target;
        return;
      }

      /**
       * Failed swipe:
       * return to the centre, pass it slightly, then settle.
       */
      if (!direction) {
        const bounce =
          event.translationX < 0
            ? -0.025
            : event.translationX > 0
              ? 0.025
              : 0;

        centerIndex.value =
          withSequence(
            withTiming(
              target + bounce,
              {
                duration: 180,
                easing: Easing.out(
                  Easing.cubic,
                ),
              },
            ),
            withSpring(target, {
              damping: 19,
              stiffness: 240,
              mass: 0.55,
              overshootClamping: false,
            }),
          );

        return;
      }

      /**
       * Successful swipe:
       * quick start, ease-out, slight overshoot, then settle.
       */
      const overshoot =
        direction === 'next'
          ? 0.04
          : -0.04;

      centerIndex.value =
        withSequence(
          withTiming(
            target + overshoot,
            {
              duration: 220,
              easing: Easing.out(
                Easing.cubic,
              ),
            },
          ),
          withSpring(target, {
            damping: 10,
            stiffness: 230,
            mass: 0.55,
            overshootClamping: false,
          }),
        );
    });

  /**
   * Opens the active profile when the touch did not become a swipe.
   */
  const tap = Gesture.Tap()
    .maxDistance(10)
    .maxDuration(450)
    .onEnd((_event, success) => {
      if (success && profiles.length > 0) {
        runOnJS(openCardAtIndex)(Math.round(centerIndex.value));
      }
    });

  /**
   * Both recognizers observe the touch.
   *
   * Moving farther than ten pixels fails the tap, leaving the pan gesture to
   * handle the swipe. A stationary touch opens the profile.
   */
  const deckGesture = Gesture.Simultaneous(
    swipe,
    tap,
  );

  return (
    <GestureDetector gesture={deckGesture}>
      <View
        collapsable={false}
        style={styles.deck}
        testID={
          activeProfile
            ? testIds.daily.deck
            : undefined
        }
        accessible={Boolean(activeProfile)}
        accessibilityRole={
          activeProfile
            ? 'adjustable'
            : undefined
        }
        accessibilityLabel={
          activeProfile
            ? t(
                'daily.deckA11y',
                {
                  name:
                    activeProfile.firstName,
                  current:
                    activeIndex + 1,
                  total:
                    profiles.length,
                },
              )
            : undefined
        }
        accessibilityHint={
          activeProfile
            ? t('daily.deckHint')
            : undefined
        }
        accessibilityValue={
          activeProfile
            ? {
                min: 1,
                max: profiles.length,
                now: activeIndex + 1,
              }
            : undefined
        }
        accessibilityActions={
          activeProfile
            ? [
                {
                  name: 'increment',
                },
                {
                  name: 'decrement',
                },
              ]
            : undefined
        }
        onAccessibilityTap={
          activeProfile
            ? () => onPress(activeProfile.id)
            : undefined
        }
        onAccessibilityAction={({
          nativeEvent,
        }) => {
          if (!activeProfile) {
            return;
          }

          if (
            nativeEvent.actionName ===
              'increment' ||
            nativeEvent.actionName ===
              'decrement'
          ) {
            moveForAccessibility(
              deckDirectionForAccessibilityAction(
                nativeEvent.actionName,
              ),
            );
          }
        }}
      >
        {profiles.map(
          (profile, index) => (
            <DeckCard
              key={profile.id}
              profile={profile}
              index={index}
              count={profiles.length}
              cardWidth={cardWidth}
              centerIndex={centerIndex}
              tiltX={tiltX}
              tiltY={tiltY}
              ringYaw={ringYaw}
              isActive={
                profile.id === activeId
              }
              popMode={popMode}
              chosen={chosen}
              reducedMotion={reducedMotion}
            />
          ),
        )}
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
  tiltX: SharedValue<number>;
  tiltY: SharedValue<number>;
  ringYaw: SharedValue<number>;
  isActive: boolean;
  popMode: boolean;
  chosen: boolean;
  reducedMotion: boolean;
}

function DeckCard({
  profile,
  index,
  count,
  cardWidth,
  centerIndex,
  tiltX,
  tiltY,
  ringYaw,
  isActive,
  popMode,
  chosen,
  reducedMotion,
}: DeckCardProps) {
  const { t, isRTL } =
    useI18n();

  const pivotDepth = Math.max(
    cardWidth * 2.7,
    780,
  );

  const settleScale =
    useSharedValue(1);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    if (reducedMotion) {
      settleScale.value = 1;
      return;
    }

    settleScale.value =
      withSequence(
        withSpring(1.018, {
          damping: 16,
          stiffness: 240,
          mass: 5.55,
        }),
        withSpring(1, {
          damping: 16,
          stiffness: 190,
          mass: 5.65,
        }),
      );
  }, [
    isActive,
    reducedMotion,
    settleScale,
  ]);

  const cardStyle =
    useAnimatedStyle(() => {
      if (count <= 0) {
        return {
          opacity: 0,
        };
      }

      const safeCenterIndex =
        finiteOrZero(
          centerIndex.value,
        );

      const centre =
        ((safeCenterIndex %
          count) +
          count) %
        count;

      let relative =
        index - centre;

      if (
        relative >
        count / 2
      ) {
        relative -= count;
      }

      if (
        relative <
        -count / 2
      ) {
        relative += count;
      }

      const distance =
        Math.abs(relative);

      const horizontal =
        relative * cardWidth;

      const arcInput = clamp(
        horizontal / pivotDepth,
        -0.72,
        0.72,
      );

      const arcAngle =
        Math.asin(arcInput);

      const scale =
        1 -
        Math.min(
          distance,
          1,
        ) *
          0.17;

      const opacity =
        Math.max(
          0,
          1 -
            Math.max(
              0,
              distance - 0.85,
            ) *
              0.55,
        );

      const deckRotateY =
        -arcAngle * 16;

      const safeTiltX = clamp(
        finiteOrZero(
          tiltX.value,
        ),
        -MAX_TILT_ANGLE,
        MAX_TILT_ANGLE,
      );

      const safeTiltY = clamp(
        finiteOrZero(
          tiltY.value,
        ),
        -MAX_TILT_ANGLE,
        MAX_TILT_ANGLE,
      );

      const safeRingYaw = clamp(
        finiteOrZero(
          ringYaw.value,
        ),
        -MAX_RING_YAW,
        MAX_RING_YAW,
      );

      const safeScale =
        Number.isFinite(
          settleScale.value,
        )
          ? settleScale.value
          : 1;

      return {
        opacity:
          Number.isFinite(opacity)
            ? opacity
            : 1,

        zIndex: Math.round(
          100 -
            distance * 10,
        ),

        transform: [
          {
            perspective: 900,
          },

          /**
           * Shared ring-facing angle.
           *
           * Every card receives the same yaw before its existing ring
           * position is applied, so the complete set faces left or right.
           */
          {
            rotateY: `${safeRingYaw}deg`,
          },

          /**
           * Existing position within the circular deck.
           */
          {
            translateY:
              pivotDepth,
          },
          {
            rotateZ: `${arcAngle}rad`,
          },
          {
            translateY:
              -pivotDepth,
          },

          /**
           * Existing gyroscope tilt and local card direction.
           */
          {
            rotateX: `${safeTiltX}deg`,
          },
          {
            rotateY: `${
              deckRotateY +
              safeTiltY
            }deg`,
          },
          {
            scale:
              scale *
              safeScale,
          },
        ],
      };
    });

  /**
   * Animated grain visibility follows the physical centre of the deck instead
   * of React's activeId. This removes the pause and prevents the grain from
   * disappearing during repeated swipes.
   *
   * The WebP itself always keeps autoplay enabled. We only animate this
   * wrapper's opacity.
   */
  const filmGrainStyle =
    useAnimatedStyle(() => {
      if (count <= 0) {
        return {
          opacity: 0,
        };
      }

      const safeCenterIndex =
        finiteOrZero(
          centerIndex.value,
        );

      const centre =
        ((safeCenterIndex %
          count) +
          count) %
        count;

      let relative =
        index - centre;

      if (
        relative >
        count / 2
      ) {
        relative -= count;
      }

      if (
        relative <
        -count / 2
      ) {
        relative += count;
      }

      const distance =
        Math.abs(relative);

      const presence =
        distance <= 1
          ? 1 -
            distance *
              (
                1 -
                FILM_GRAIN_NEIGHBOUR_STRENGTH
              )
          : 0;

      return {
        opacity:
          FILM_GRAIN_OPACITY *
          presence,
      };
    });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.card,
        isActive &&
          chosen &&
          styles.cardChosen,
        cardStyle,
      ]}
    >
      <Image
        source={profile.photos[0]}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        accessibilityIgnoresInvertColors
      />

      <LinearGradient
        pointerEvents="none"
        colors={[
          'transparent',
          'rgba(10,10,10,0.12)',
          'rgba(10,10,10,0.72)',
        ]}
        locations={[
          0.32,
          0.54,
          1,
        ]}
        style={StyleSheet.absoluteFill}
      />

      {/*
       * Never toggle autoplay with isActive.
       *
       * Toggling animated-image playback during every handoff could leave the
       * native image paused after several swipes. The WebP now loops
       * continuously, while the wrapper controls only visibility.
       */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          styles.filmGrainLayer,
          filmGrainStyle,
        ]}
      >
        <Image
          pointerEvents="none"
          source={require(
            './film-grain-animated.webp'
          )}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          autoplay
          transition={0}
          cachePolicy="memory-disk"
          priority="high"
          recyclingKey={`film-grain-${
            profile.id
          }`}
          accessibilityIgnoresInvertColors
        />
      </Animated.View>

      <View
        style={[
          styles.caption,
          isRTL &&
            styles.rtl,
        ]}
        pointerEvents="none"
      >
        <Text style={styles.name}>
          {profile.name}
        </Text>

        <Text style={styles.line}>
          {profile.age} ·{' '}
          {profile.city} ·{' '}
          {profile.occupation}
        </Text>
      </View>

      {isActive &&
      popMode ? (
        <View
          style={styles.popBadge}
          pointerEvents="none"
        >
          <Text
            style={
              styles.popBadgeLabel
            }
          >
            {t('daily.popLabel')}
          </Text>
        </View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  rtl: {
    direction: 'rtl',
  },

  deck: {
    flex: 1,
    marginHorizontal: 30,
    overflow: 'visible',
  },

  card: {
    ...StyleSheet.absoluteFill,
    borderRadius: radius.hero,
    overflow: 'hidden',
    backgroundColor: color.clay,
    shadowColor: '#000000',
    shadowOpacity: 0.95,
    shadowRadius: 999,
    shadowOffset: {
      width: 0,
      height: 12,
    },
    elevation: 40,
  },

  cardChosen: {
    shadowColor: '#C5A054',
    shadowOpacity: 0.7,
    shadowRadius: 26,
    shadowOffset: {
      width: 0,
      height: 0,
    },
    elevation: 12,
  },

  filmGrainLayer: {
    zIndex: 2,
  },

  caption: {
    zIndex: 3,
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 22,
    paddingBottom: 16,
    alignItems: 'center',
  },

  name: {
    fontFamily:
      'PlayfairDisplay_400Regular',
    fontSize: 24,
    lineHeight: 28,
    color: color.white,
    textAlign: 'center',
  },

  line: {
    fontFamily:
      'Beiruti_400Regular',
    fontSize: 11.5,
    color:
      'rgba(252,252,251,0.78)',
    marginTop: 4,
    textAlign: 'center',
  },

  popBadge: {
    position: 'absolute',
    zIndex: 4,
    top: 14,
    left: 14,
    backgroundColor:
      'rgba(252,252,251,0.94)',
    borderRadius: radius.pill,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },

  popBadgeLabel: {
    fontFamily:
      'Beiruti_700Bold',
    fontSize: 9.5,
    letterSpacing: 1.7,
    textTransform: 'uppercase',
    color: color.ink,
  },
});