// Expo Router 57 vendors the matching navigation types.
// Importing this from a separately installed navigation package can create
// incompatible duplicate types.
import type { BottomTabBarProps } from 'expo-router/build/react-navigation/bottom-tabs';

import * as Haptics from 'expo-haptics';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  Path,
  Rect,
  Stop,
} from 'react-native-svg';

import { useI18n } from '@/i18n';
import { font } from '@/theme/tokens';

const BAR_HEIGHT = 78;

const PILL_HEIGHT = 60;
const PILL_RADIUS = PILL_HEIGHT / 2;
const PILL_TOP = 8;

/**
 * Roughly 50% transparent glass body.
 *
 * This does not reduce the opacity of the text, symbols,
 * borders or highlights.
 */
const GLASS_BODY_ALPHA = 0.5;

type TabRouteName = 'daily' | 'connections' | 'you';

const PILL_WIDTHS: Record<TabRouteName, number> = {
  daily: 116,
  connections: 176,
  you: 108,
};

/** Width used for any route without a measured pill of its own. */
const DEFAULT_PILL_WIDTH = 130;

function isTabRouteName(
  name: string | undefined,
): name is TabRouteName {
  return (
    name === 'daily' ||
    name === 'connections' ||
    name === 'you'
  );
}

const MARKS: Record<string, string> = {
  daily: '✦',
  connections: '♥',
  you: '✿',
};

const MARK_COLORS: Record<string, string> = {
  daily: '#737373',
  connections: '#F47E97',
  you: '#9D9D9D',
};

const POSITION_SPRING = {
  damping: 14.5,
  stiffness: 175,
  mass: 0.82,
  overshootClamping: false,
  restDisplacementThreshold: 0.08,
  restSpeedThreshold: 0.08,
};

const WIDTH_SPRING = {
  damping: 8.8,
  stiffness: 165,
  mass: 0.82,
  overshootClamping: false,
  restDisplacementThreshold: 0.06,
  restSpeedThreshold: 0.06,
};

const PRESS_RETURN_SPRING = {
  damping: 8.5,
  stiffness: 255,
  mass: 0.56,
  overshootClamping: false,
  restDisplacementThreshold: 0.02,
  restSpeedThreshold: 0.02,
};

const TITLE_ENTRY_SPRING = {
  damping: 8,
  stiffness: 195,
  mass: 0.66,
  overshootClamping: false,
  restDisplacementThreshold: 0.01,
  restSpeedThreshold: 0.01,
};

const TITLE_RETURN_SPRING = {
  damping: 15,
  stiffness: 215,
  mass: 0.68,
  overshootClamping: false,
  restDisplacementThreshold: 0.01,
  restSpeedThreshold: 0.01,
};

const MARK_ENTRY_SPRING = {
  damping: 7,
  stiffness: 205,
  mass: 0.62,
  overshootClamping: false,
  restDisplacementThreshold: 0.01,
  restSpeedThreshold: 0.01,
};

const MARK_RETURN_SPRING = {
  damping: 15,
  stiffness: 220,
  mass: 0.66,
  overshootClamping: false,
  restDisplacementThreshold: 0.01,
  restSpeedThreshold: 0.01,
};

interface ElasticTitleProps {
  focused: boolean;
  label: string;
}

function ElasticTitle({
  focused,
  label,
}: ElasticTitleProps) {
  const scale = useSharedValue(focused ? 1.13 : 1);
  const translateY = useSharedValue(focused ? -0.5 : 0);
  const opacity = useSharedValue(focused ? 1 : 0.6);

  useEffect(() => {
    cancelAnimation(scale);
    cancelAnimation(translateY);
    cancelAnimation(opacity);

    if (focused) {
      scale.value = withDelay(
        52,
        withSequence(
          withTiming(0.94, {
            duration: 50,
          }),
          withSpring(
            1.13,
            TITLE_ENTRY_SPRING,
          ),
        ),
      );

      translateY.value = withDelay(
        52,
        withSpring(
          -0.5,
          TITLE_ENTRY_SPRING,
        ),
      );

      opacity.value = withDelay(
        30,
        withTiming(1, {
          duration: 150,
        }),
      );

      return;
    }

    scale.value = withSpring(
      1,
      TITLE_RETURN_SPRING,
    );

    translateY.value = withSpring(
      0,
      TITLE_RETURN_SPRING,
    );

    opacity.value = withTiming(0.6, {
      duration: 140,
    });
  }, [
    focused,
    opacity,
    scale,
    translateY,
  ]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      {
        translateY: translateY.value,
      },
      {
        scale: scale.value,
      },
    ],
  }));

  return (
    <Animated.Text
      numberOfLines={1}
      style={[
        styles.label,
        focused && styles.labelFocused,
        animatedStyle,
      ]}
    >
      {label}
    </Animated.Text>
  );
}

interface ElasticMarkProps {
  focused: boolean;
  mark: string;
  color: string;
}

function ElasticMark({
  focused,
  mark,
  color,
}: ElasticMarkProps) {
  const scale = useSharedValue(focused ? 1.22 : 1);
  const translateY = useSharedValue(focused ? -0.5 : 0);
  const rotation = useSharedValue(0);
  const opacity = useSharedValue(focused ? 1 : 0.64);

  useEffect(() => {
    cancelAnimation(scale);
    cancelAnimation(translateY);
    cancelAnimation(rotation);
    cancelAnimation(opacity);

    if (focused) {
      /**
       * The mark animates 34ms after the title.
       */
      scale.value = withDelay(
        86,
        withSequence(
          withTiming(0.88, {
            duration: 44,
          }),
          withSpring(
            1.22,
            MARK_ENTRY_SPRING,
          ),
        ),
      );

      translateY.value = withDelay(
        86,
        withSpring(
          -0.5,
          MARK_ENTRY_SPRING,
        ),
      );

      rotation.value = withDelay(
        86,
        withSequence(
          withTiming(-5, {
            duration: 44,
          }),
          withSpring(
            0,
            MARK_ENTRY_SPRING,
          ),
        ),
      );

      opacity.value = withDelay(
        62,
        withTiming(1, {
          duration: 135,
        }),
      );

      return;
    }

    scale.value = withSpring(
      1,
      MARK_RETURN_SPRING,
    );

    translateY.value = withSpring(
      0,
      MARK_RETURN_SPRING,
    );

    rotation.value = withSpring(
      0,
      MARK_RETURN_SPRING,
    );

    opacity.value = withTiming(0.64, {
      duration: 140,
    });
  }, [
    focused,
    opacity,
    rotation,
    scale,
    translateY,
  ]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      {
        translateY: translateY.value,
      },
      {
        rotate: `${rotation.value}deg`,
      },
      {
        scale: scale.value,
      },
    ],
  }));

  return (
    <Animated.Text
      style={[
        styles.mark,
        {
          color,
        },
        animatedStyle,
      ]}
    >
      {mark}
    </Animated.Text>
  );
}

/**
 * Resolution-independent optical detailing.
 *
 * These SVG shapes imitate edge refraction and curved
 * glass highlights without raster-image softness.
 */
function GlassRefraction() {
  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
    >
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 1000 300"
        preserveAspectRatio="none"
      >
        <Defs>
          <SvgLinearGradient
            id="outerRim"
            x1="0"
            y1="0"
            x2="1"
            y2="1"
          >
            <Stop
              offset="0"
              stopColor="#FFFFFF"
              stopOpacity="0.95"
            />

            <Stop
              offset="0.18"
              stopColor="#FFFFFF"
              stopOpacity="0.58"
            />

            <Stop
              offset="0.48"
              stopColor="#FFFFFF"
              stopOpacity="0.08"
            />

            <Stop
              offset="0.74"
              stopColor="#6E7884"
              stopOpacity="0.16"
            />

            <Stop
              offset="1"
              stopColor="#FFFFFF"
              stopOpacity="0.72"
            />
          </SvgLinearGradient>

          <SvgLinearGradient
            id="innerRefraction"
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <Stop
              offset="0"
              stopColor="#7D8793"
              stopOpacity="0.22"
            />

            <Stop
              offset="0.32"
              stopColor="#FFFFFF"
              stopOpacity="0.04"
            />

            <Stop
              offset="0.72"
              stopColor="#FFFFFF"
              stopOpacity="0.06"
            />

            <Stop
              offset="1"
              stopColor="#FFFFFF"
              stopOpacity="0.7"
            />
          </SvgLinearGradient>

          <SvgLinearGradient
            id="upperSweep"
            x1="0"
            y1="0"
            x2="1"
            y2="0.6"
          >
            <Stop
              offset="0"
              stopColor="#FFFFFF"
              stopOpacity="0"
            />

            <Stop
              offset="0.14"
              stopColor="#FFFFFF"
              stopOpacity="0.46"
            />

            <Stop
              offset="0.42"
              stopColor="#FFFFFF"
              stopOpacity="0.14"
            />

            <Stop
              offset="0.72"
              stopColor="#FFFFFF"
              stopOpacity="0.34"
            />

            <Stop
              offset="1"
              stopColor="#FFFFFF"
              stopOpacity="0"
            />
          </SvgLinearGradient>

          <SvgLinearGradient
            id="bottomSweep"
            x1="0"
            y1="0"
            x2="1"
            y2="0"
          >
            <Stop
              offset="0"
              stopColor="#FFFFFF"
              stopOpacity="0"
            />

            <Stop
              offset="0.18"
              stopColor="#FFFFFF"
              stopOpacity="0.45"
            />

            <Stop
              offset="0.52"
              stopColor="#FFFFFF"
              stopOpacity="0.12"
            />

            <Stop
              offset="0.84"
              stopColor="#FFFFFF"
              stopOpacity="0.54"
            />

            <Stop
              offset="1"
              stopColor="#FFFFFF"
              stopOpacity="0"
            />
          </SvgLinearGradient>
        </Defs>

        <Rect
          x="8"
          y="8"
          width="984"
          height="284"
          rx="142"
          fill="none"
          stroke="url(#outerRim)"
          strokeWidth="12"
          opacity="0.82"
        />

        <Rect
          x="34"
          y="31"
          width="932"
          height="238"
          rx="119"
          fill="none"
          stroke="url(#innerRefraction)"
          strokeWidth="8"
          opacity="0.7"
        />

        <Path
          d="
            M 42 110
            C 215 25, 690 20, 964 94
            C 695 66, 318 76, 42 152
            Z
          "
          fill="url(#upperSweep)"
          opacity="0.44"
        />

        <Path
          d="
            M 54 87
            C 285 35, 690 41, 948 84
          "
          fill="none"
          stroke="url(#upperSweep)"
          strokeWidth="10"
          strokeLinecap="round"
          opacity="0.74"
        />

        <Path
          d="
            M 72 235
            C 302 276, 720 276, 936 226
          "
          fill="none"
          stroke="url(#bottomSweep)"
          strokeWidth="12"
          strokeLinecap="round"
          opacity="0.62"
        />

        <Path
          d="
            M 88 62
            C 24 105, 22 198, 86 242
          "
          fill="none"
          stroke="#FFFFFF"
          strokeWidth="10"
          strokeLinecap="round"
          opacity="0.52"
        />

        <Path
          d="
            M 916 62
            C 976 108, 974 196, 916 242
          "
          fill="none"
          stroke="#5E6874"
          strokeWidth="5"
          strokeLinecap="round"
          opacity="0.16"
        />
      </Svg>
    </View>
  );
}

export function TabBar({
  state,
  navigation,
}: BottomTabBarProps) {
  const { t, isRTL } = useI18n();
  const insets = useSafeAreaInsets();

  const [layoutWidth, setLayoutWidth] = useState(0);

  const pillCenterX = useSharedValue(0);
  const pillWidth = useSharedValue(
    PILL_WIDTHS.daily,
  );

  const pressScaleX = useSharedValue(1);
  const pressScaleY = useSharedValue(1);
  const pressTranslateY = useSharedValue(0);

  const hasInitialPosition = useRef(false);

  const routes = state.routes;
  const routeCount = routes.length || 1;

  const labels = useMemo(
    () =>
      routes.map((route) =>
        tabLabel(route.name, t),
      ),
    [routes, t],
  );

  useEffect(() => {
    if (!layoutWidth) {
      return;
    }

    const slotWidth =
      layoutWidth / routeCount;

    const activeRouteName =
      routes[state.index]?.name;

    const requestedWidth =
      isTabRouteName(activeRouteName)
        ? PILL_WIDTHS[activeRouteName]
        : DEFAULT_PILL_WIDTH;

    const maximumWidth = Math.max(
      112,
      layoutWidth * 0.54,
    );

    const nextWidth = Math.min(
      requestedWidth,
      maximumWidth,
    );

    const visualIndex = isRTL
      ? routeCount - 1 - state.index
      : state.index;

    const nextCenterX =
      visualIndex * slotWidth +
      slotWidth / 2;

    if (!hasInitialPosition.current) {
      pillCenterX.value = nextCenterX;
      pillWidth.value = nextWidth;
      hasInitialPosition.current = true;
      return;
    }

    pillCenterX.value = withSpring(
      nextCenterX,
      POSITION_SPRING,
    );

    pillWidth.value = withSpring(
      nextWidth,
      WIDTH_SPRING,
    );
  }, [
    isRTL,
    layoutWidth,
    pillCenterX,
    pillWidth,
    routeCount,
    routes,
    state.index,
  ]);

  const pillAnimatedStyle = useAnimatedStyle(() => {
    const currentWidth = pillWidth.value;

    return {
      width: currentWidth,
      transform: [
        {
          translateX:
            pillCenterX.value -
            currentWidth / 2,
        },
        {
          translateY:
            pressTranslateY.value,
        },
        {
          scaleX:
            pressScaleX.value,
        },
        {
          scaleY:
            pressScaleY.value,
        },
      ],
    };
  });

  const handlePressIn = () => {
    cancelAnimation(pressScaleX);
    cancelAnimation(pressScaleY);
    cancelAnimation(pressTranslateY);

    /**
     * Pronounced horizontal stretch and vertical squeeze.
     */
    pressScaleX.value = withTiming(
      1.105,
      {
        duration: 90,
      },
    );

    pressScaleY.value = withTiming(
      0.82,
      {
        duration: 90,
      },
    );

    pressTranslateY.value = withTiming(
      2.4,
      {
        duration: 90,
      },
    );
  };

  const handlePressOut = () => {
    cancelAnimation(pressScaleX);
    cancelAnimation(pressScaleY);
    cancelAnimation(pressTranslateY);

    pressScaleX.value = withSequence(
      withTiming(0.955, {
        duration: 72,
      }),
      withSpring(
        1,
        PRESS_RETURN_SPRING,
      ),
    );

    pressScaleY.value = withSequence(
      withTiming(1.09, {
        duration: 72,
      }),
      withSpring(
        1,
        PRESS_RETURN_SPRING,
      ),
    );

    pressTranslateY.value = withSpring(
      0,
      PRESS_RETURN_SPRING,
    );
  };

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.wrapper,
        {
          paddingBottom: Math.max(
            insets.bottom - 4,
            4,
          ),
        },
      ]}
    >
      <View
        style={[
          styles.barArea,
          isRTL && styles.rowReverse,
        ]}
        onLayout={(event) => {
          setLayoutWidth(
            event.nativeEvent.layout.width,
          );
        }}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            styles.pillOuter,
            pillAnimatedStyle,
          ]}
        >
          <View style={styles.ambientShadow} />
          <View style={styles.contactShadow} />

          <View style={styles.pillClip}>
            {/*
             * No Android-specific blurMethod is selected.
             * This prevents the missing blurTarget warning.
             */}
            <BlurView
              intensity={32}
              tint="light"
              style={StyleSheet.absoluteFill}
            />

            <View style={styles.glassBody} />

            <LinearGradient
              colors={[
                'rgba(255,255,255,0.54)',
                'rgba(255,255,255,0.20)',
                'rgba(230,236,243,0.10)',
                'rgba(255,255,255,0.32)',
              ]}
              locations={[
                0,
                0.31,
                0.68,
                1,
              ]}
              start={{
                x: 0.05,
                y: 0,
              }}
              end={{
                x: 0.96,
                y: 1,
              }}
              style={StyleSheet.absoluteFill}
            />

            <LinearGradient
              colors={[
                'rgba(70,78,88,0.19)',
                'rgba(95,104,114,0.08)',
                'rgba(255,255,255,0)',
              ]}
              locations={[
                0,
                0.44,
                1,
              ]}
              start={{
                x: 0.5,
                y: 0,
              }}
              end={{
                x: 0.5,
                y: 1,
              }}
              style={styles.upperInsetShadow}
            />

            <LinearGradient
              colors={[
                'rgba(255,255,255,0)',
                'rgba(255,255,255,0.2)',
                'rgba(255,255,255,0.72)',
              ]}
              locations={[
                0,
                0.54,
                1,
              ]}
              start={{
                x: 0.5,
                y: 0,
              }}
              end={{
                x: 0.5,
                y: 1,
              }}
              style={styles.lowerBevel}
            />

            <LinearGradient
              colors={[
                'rgba(255,255,255,0.82)',
                'rgba(255,255,255,0.34)',
                'rgba(255,255,255,0)',
              ]}
              locations={[
                0,
                0.4,
                1,
              ]}
              start={{
                x: 0.12,
                y: 0,
              }}
              end={{
                x: 0.82,
                y: 1,
              }}
              style={styles.topGloss}
            />

            <View style={styles.innerWell} />

            <GlassRefraction />

            <View style={styles.outerRim} />
            <View style={styles.innerRim} />
          </View>
        </Animated.View>

        <View
          style={[
            styles.tabsRow,
            isRTL && styles.rowReverse,
          ]}
        >
          {routes.map(
            (route, routeIndex) => {
              const focused =
                state.index === routeIndex;

              const label =
                labels[routeIndex] ??
                tabLabel(route.name, t);

              return (
                <Pressable
                  testID={`tab-${route.name}`}
                  key={route.key}
                  accessibilityRole="tab"
                  accessibilityState={{
                    selected: focused,
                  }}
                  accessibilityLabel={label}
                  hitSlop={{
                    top: 9,
                    bottom: 9,
                    left: 7,
                    right: 7,
                  }}
                  style={styles.tabButton}
                  onPressIn={handlePressIn}
                  onPressOut={handlePressOut}
                  onPress={() => {
                    const event =
                      navigation.emit({
                        type: 'tabPress',
                        target: route.key,
                        canPreventDefault: true,
                      });

                    if (
                      event.defaultPrevented
                    ) {
                      return;
                    }

                    void Haptics.selectionAsync();

                    if (!focused) {
                      navigation.navigate(
                        route.name,
                      );
                    }
                  }}
                  onLongPress={() => {
                    navigation.emit({
                      type: 'tabLongPress',
                      target: route.key,
                    });
                  }}
                >
                  <View
                    style={[
                      styles.tabContent,
                      isRTL &&
                        styles.rowReverse,
                    ]}
                  >
                    <ElasticMark
                      focused={focused}
                      mark={
                        MARKS[route.name] ??
                        '•'
                      }
                      color={
                        MARK_COLORS[
                          route.name
                        ] ?? '#999999'
                      }
                    />

                    <ElasticTitle
                      focused={focused}
                      label={label}
                    />
                  </View>
                </Pressable>
              );
            },
          )}
        </View>
      </View>
    </View>
  );
}

function tabLabel(
  name: string,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (name === 'daily') {
    return t('nav.daily');
  }

  if (name === 'connections') {
    return t('nav.connections');
  }

  if (name === 'you') {
    return t('nav.you');
  }

  return name;
}

const styles = StyleSheet.create({
  rowReverse: {
    flexDirection: 'row-reverse',
  },

  wrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1000,
    elevation: 1000,
    backgroundColor: 'transparent',
    overflow: 'visible',
  },

  barArea: {
    height: BAR_HEIGHT,
    marginHorizontal: 20,
    position: 'relative',
    backgroundColor: 'transparent',
    overflow: 'visible',
  },

  pillOuter: {
    position: 'absolute',
    top: PILL_TOP,
    left: 0,
    height: PILL_HEIGHT,
    borderRadius: PILL_RADIUS,
    backgroundColor: 'transparent',
    overflow: 'visible',

    boxShadow:
      '0 18px 30px -11px rgba(42,48,56,0.28), 0 5px 11px -4px rgba(28,33,39,0.24)',

    shadowColor: '#27303A',
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: {
      width: 0,
      height: 10,
    },

    elevation: 10,
  },

  ambientShadow: {
    position: 'absolute',
    left: 7,
    right: 7,
    top: 12,
    bottom: -11,
    borderRadius: PILL_RADIUS,
    backgroundColor:
      'rgba(65,72,82,0.09)',
    transform: [
      {
        scaleX: 1.04,
      },
    ],
  },

  contactShadow: {
    position: 'absolute',
    left: 4,
    right: 4,
    bottom: -4,
    height: 24,
    borderRadius: PILL_RADIUS,
    backgroundColor:
      'rgba(44,50,58,0.09)',
  },

  pillClip: {
    flex: 1,
    borderRadius: PILL_RADIUS,
    overflow: 'hidden',

    backgroundColor:
      `rgba(238,243,248,${GLASS_BODY_ALPHA})`,

    boxShadow:
      'inset 0 5px 11px rgba(73,82,92,0.17), inset 0 -3px 7px rgba(255,255,255,0.72)',
  },

  glassBody: {
    ...StyleSheet.absoluteFill,

    backgroundColor:
      `rgba(239,244,249,${GLASS_BODY_ALPHA})`,
  },

  upperInsetShadow: {
    position: 'absolute',
    top: 0,
    left: 12,
    right: 12,
    height: 28,

    borderTopLeftRadius:
      PILL_RADIUS,

    borderTopRightRadius:
      PILL_RADIUS,
  },

  lowerBevel: {
    position: 'absolute',
    left: 7,
    right: 7,
    bottom: 0,
    height: 25,

    borderBottomLeftRadius:
      PILL_RADIUS,

    borderBottomRightRadius:
      PILL_RADIUS,
  },

  topGloss: {
    position: 'absolute',
    top: 2,
    left: 13,
    right: 13,
    height: 23,
    borderRadius: 18,
    opacity: 0.78,
  },

  innerWell: {
    position: 'absolute',
    top: 4,
    left: 5,
    right: 5,
    bottom: 4,

    borderRadius:
      PILL_RADIUS - 4,

    borderTopWidth: 1.2,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1.2,

    borderTopColor:
      'rgba(79,88,99,0.20)',

    borderLeftColor:
      'rgba(104,113,122,0.11)',

    borderRightColor:
      'rgba(255,255,255,0.52)',

    borderBottomColor:
      'rgba(255,255,255,0.66)',
  },

  outerRim: {
    ...StyleSheet.absoluteFill,

    borderRadius:
      PILL_RADIUS,

    borderWidth: 1.2,

    borderTopColor:
      'rgba(255,255,255,0.96)',

    borderLeftColor:
      'rgba(255,255,255,0.80)',

    borderRightColor:
      'rgba(110,120,132,0.26)',

    borderBottomColor:
      'rgba(255,255,255,0.75)',
  },

  innerRim: {
    position: 'absolute',
    top: 2,
    left: 2,
    right: 2,
    bottom: 2,

    borderRadius:
      PILL_RADIUS - 2,

    borderWidth: 1,

    borderTopColor:
      'rgba(78,86,96,0.14)',

    borderLeftColor:
      'rgba(255,255,255,0.18)',

    borderRightColor:
      'rgba(255,255,255,0.44)',

    borderBottomColor:
      'rgba(255,255,255,0.62)',
  },

  tabsRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,

    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'space-between',

    backgroundColor: 'transparent',
  },

  tabButton: {
    flex: 1,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },

  tabContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 8,
    backgroundColor: 'transparent',
  },

  mark: {
    fontFamily: font.body,
    fontSize: 12.5,
    lineHeight: 17,
    includeFontPadding: false,
  },

  label: {
    fontFamily: font.bodySemi,
    fontSize: 12.5,
    lineHeight: 17,
    letterSpacing: 0.18,
    color: '#929292',
    includeFontPadding: false,
  },

  labelFocused: {
    color: '#111111',
  },
});