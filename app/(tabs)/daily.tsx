import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { ArcCarousel } from '@/components/introductions/ArcCarousel';
import { HeroCard } from '@/components/introductions/HeroCard';
import { BrandHeader } from '@/components/navigation/BrandHeader';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useCameraShake } from '@/hooks/useCameraShake';
import { playPop, startShimmer, stopShimmer } from '@/lib/sound';
import { useRound } from '@/state/round';
import { alpha, color, font, radius, space } from '@/theme/tokens';

export default function DailyScreen() {
  const {
    round,
    isLoading,
    live,
    activeId,
    active,
    keepLimit,
    inChosenZone,
    remaining,
    popMode,
    canPop,
    togglePopMode,
    setActive,
    release,
    submit,
    submitting,
    submitted,
    reset,
  } = useRound();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmLetGo, setConfirmLetGo] = useState(false);
  const [interestTargetId, setInterestTargetId] = useState<string | null>(null);
  const { shake, style: shakeStyle } = useCameraShake();
  const popPulse = useSharedValue(0);

  useEffect(() => {
    if (!popMode) {
      popPulse.value = 0;
      return;
    }

    popPulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1050, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: 1050, easing: Easing.in(Easing.quad) })
      ),
      -1
    );
  }, [popMode, popPulse]);

  const popPulseStyle = useAnimatedStyle(() => ({
    opacity: popPulse.value * 0.7,
    transform: [{ scale: 1 + popPulse.value * 0.1 }],
  }));

  // The shimmer runs for as long as the set sits at its final size, and stops
  // the moment interest is sent or the screen goes away.
  useEffect(() => {
    if (inChosenZone && !submitted) startShimmer();
    else stopShimmer();
    return stopShimmer;
  }, [inChosenZone, submitted]);

  const handleRelease = useCallback(
    (id: string) => {
      playPop();
      shake();
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      // The burst itself is owned by ArcCarousel, which knows where each face
      // sits and can fire the particles from exactly that point.
      release(id);
    },
    [release, shake]
  );

  // Letting the last one go ends the round with nothing kept — irreversible,
  // hence its own confirmation.
  const handleLetGoFinal = useCallback(async () => {
    setConfirmLetGo(false);
    const last = live[0];
    if (last) release(last.id);
    await submit();
  }, [live, release, submit]);

  const handleSubmit = useCallback(async () => {
    setConfirmOpen(false);
    const mutual = await submit(interestTargetId ? [interestTargetId] : undefined);
    if (mutual.length > 0 && mutual[0]) {
      router.push(`/match/${mutual[0]}`);
    }
  }, [interestTargetId, submit]);

  const openInterestConfirmation = useCallback((id?: string) => {
    setInterestTargetId(id ?? null);
    setConfirmOpen(true);
  }, []);

  const moveActiveIntroduction = useCallback(
    (direction: 'previous' | 'next') => {
      if (!activeId || live.length < 2) return;
      const currentIndex = live.findIndex((item) => item.id === activeId);
      if (currentIndex < 0) return;
      const offset = direction === 'next' ? 1 : -1;
      const nextIndex = (currentIndex + offset + live.length) % live.length;
      const next = live[nextIndex];
      if (next) setActive(next.id);
    },
    [activeId, live, setActive]
  );

  if (isLoading || !round) {
    return (
      <Screen withTabBar>
        <BrandHeader />
        <View style={styles.centred}>
          <ActivityIndicator color={color.ink} />
        </View>
      </Screen>
    );
  }

  if (submitted) {
    return <SetCompleteState onReset={reset} />;
  }

  // The last introduction standing gets a named release instead of a toggle.
  // Pop mode itself is already off for the whole chosen zone — see RoundProvider —
  // so on Plus the three survivors keep their button but lose their pins.
  const isFinal = live.length === 1;
  const finalName = live[0]?.profile.firstName ?? '';

  return (
    <Screen withTabBar>
      <BrandHeader />

      <View style={styles.headline}>
        <View style={styles.headlineText}>
          <Text variant="micro">Today · resets at fajr</Text>
          <Text variant="display" style={styles.title}>
            {round.introductions.length} introductions,{'\n'}one at a time.
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start the round again"
          onPress={reset}
          style={styles.resetButton}
        >
          <Text style={styles.resetGlyph}>↺</Text>
        </Pressable>
      </View>

      <Animated.View style={[styles.stage, shakeStyle]}>
        {active ? (
          <HeroCard
            profiles={live.map((item) => item.profile)}
            activeId={active.profile.id}
            popMode={popMode}
            chosen={inChosenZone}
            onPress={() => router.push(`/introduction/${active.id}`)}
            onSwipe={moveActiveIntroduction}
          />
        ) : null}

        {activeId ? (
          <ArcCarousel
            live={live}
            activeId={activeId}
            popMode={popMode}
            chosenZone={inChosenZone}
            onSelect={setActive}
            onOpen={(id) => router.push(`/introduction/${id}`)}
            onSendInterest={(id) => openInterestConfirmation(id)}
            onRelease={handleRelease}
          />
        ) : null}
      </Animated.View>

      <View style={styles.footer}>
        <Text variant="caption" center tone="whisper">
          {isFinal
            ? 'One introduction left today'
            : inChosenZone
              ? `${live.length} kept of ${keepLimit}.`
              : `Let go of ${remaining} more.`}
        </Text>

        <View style={styles.actions}>
          {isFinal ? (
            <Button
              label={`Let go of ${finalName}`}
              variant="secondary"
              dotColor="#CB4242"
              onPress={() => setConfirmLetGo(true)}
              style={styles.letGoAction}
            />
          ) : (
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: popMode, disabled: !canPop }}
              accessibilityLabel="Pop mode"
              accessibilityHint={
                canPop
                  ? undefined
                  : 'Unavailable — these are the introductions you are keeping'
              }
              disabled={!canPop}
              onPress={togglePopMode}
              style={[
                styles.popToggle,
                popMode && styles.popToggleOn,
                !canPop && styles.popToggleDisabled,
              ]}
            >
              <Animated.View
                pointerEvents="none"
                style={[styles.popPulse, popPulseStyle]}
              />
              <Text style={[styles.popLabel, popMode && styles.popLabelOn]}>
                {popMode ? 'Done' : 'Pop'}
              </Text>
            </Pressable>
          )}

          <Button
            label={
              inChosenZone
                ? 'Send interest'
                : `Read ${active?.profile.firstName ?? 'profile'}'s profile`
            }
            // Gold marks the one moment a choice is being sealed.
            variant={inChosenZone ? 'gold' : popMode ? 'secondary' : 'primary'}
            loading={submitting}
            onPress={() => {
              if (inChosenZone) openInterestConfirmation();
              else if (active) router.push(`/introduction/${active.id}`);
            }}
            style={styles.primaryAction}
          />
        </View>
      </View>

      <ConfirmDialog
        visible={confirmOpen}
        title={
          interestTargetId
            ? `Send interest to ${live.find((item) => item.id === interestTargetId)?.profile.firstName ?? 'this person'}?`
            : live.length === 1 && live[0]
            ? `Send interest to ${live[0].profile.firstName}?`
            : 'Send interest to your final set?'
        }
        body="They are only notified if it is mutual."
        confirmLabel="Yes, send"
        cancelLabel="Not yet"
        onConfirm={() => void handleSubmit()}
        onCancel={() => {
          setConfirmOpen(false);
          setInterestTargetId(null);
        }}
      />

      <ConfirmDialog
        visible={confirmLetGo}
        title={`Let go of ${finalName}?`}
        body="That ends today's round with no one kept. Nothing renews until Fajr."
        confirmLabel="Let go"
        cancelLabel="Keep her"
        onConfirm={() => void handleLetGoFinal()}
        onCancel={() => setConfirmLetGo(false)}
      />
    </Screen>
  );
}

/**
 * The end of the round. Deliberately a dead end — no refresh, no "see more".
 * The reference is explicit that the empty state should close the session.
 */
function SetCompleteState({ onReset }: { onReset: () => void }) {
  return (
    <Screen withTabBar>
      <BrandHeader />
      <Animated.View entering={FadeIn.duration(300)} style={styles.complete}>
        <Text variant="micro">Set complete</Text>
        <Text variant="display" center style={styles.completeTitle}>
          Nothing more today.
        </Text>
        <Text variant="bodySmall" center style={styles.completeBody}>
          That was the whole set.{'\n'}Come back at Fajr for another round.
        </Text>
        <Button
          label="Start the demo again"
          variant="quiet"
          onPress={onReset}
          style={styles.completeReset}
        />
      </Animated.View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  centred: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  headline: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 26,
    paddingTop: 6,
  },
  headlineText: { flex: 1 },
  title: { marginTop: 4 },
  resetButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: color.sandDeep,
    borderWidth: 1,
    borderColor: alpha.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resetGlyph: { fontFamily: font.body, fontSize: 14, color: color.muted },

  stage: { flex: 1, marginTop: 14, minHeight: 0 },

  footer: {
    paddingHorizontal: 26,
    paddingTop: 6,
    gap: 8,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  popToggle: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: 86,
    borderWidth: 1,
    borderColor: '#CB4242',
    borderRadius: radius.pill,
    paddingVertical: 14,
    backgroundColor: '#CB4242',
  },
  popToggleOn: { backgroundColor: color.ink, borderColor: color.ink },
  /**
   * Kept on screen but inert once these are the introductions being kept. The
   * pins are what get pressed by accident, so those go; removing the button too
   * would shift the whole row at the tensest moment of the round.
   */
  popToggleDisabled: { opacity: 0.4 },
  popPulse: {
    position: 'absolute',
    top: -3,
    right: -3,
    bottom: -3,
    left: -3,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: '#CB4242',
  },
  popLabel: { fontFamily: font.bodyBold, fontSize: 11.5, color: color.white },
  popLabelOn: { color: color.white },
  letGoAction: { flex: 0.8, paddingHorizontal: 10 },
  primaryAction: { flex: 1.35, paddingHorizontal: 10 },

  complete: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    paddingHorizontal: 40,
  },
  completeTitle: { marginTop: 4 },
  completeBody: { maxWidth: 250 },
  completeReset: { marginTop: space.sm },
});
