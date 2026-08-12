import * as Haptics from 'expo-haptics';
import { router, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pressable, StyleSheet, View } from 'react-native';
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
import { ConductAcknowledgement } from '@/components/introductions/ConductAcknowledgement';
import { FirstChoiceDialog } from '@/components/introductions/FirstChoiceDialog';
import { HeroCard } from '@/components/introductions/HeroCard';
import { BrandHeader } from '@/components/navigation/BrandHeader';
import { SafetyControl } from '@/components/safety/SafetyControl';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, InlineNotice, LoadingState } from '@/components/ui/AsyncState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useCameraShake } from '@/hooks/useCameraShake';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useI18n } from '@/i18n';
import type { TranslationKey } from '@/i18n/catalog';
import type { NarrowingCriterion } from '@/lib/dailyRoundState';
import { fetchMyProfileReadiness } from '@/api/profile';
import { trackProductEvent } from '@/lib/analytics';
import { queryKeys } from '@/lib/queryClient';
import { acceptConduct, hasAcceptedConduct } from '@/lib/conductAcknowledgement';
import { playPop, startShimmer, stopShimmer } from '@/lib/sound';
import { USE_MOCKS } from '@/lib/supabase';
import { testIds } from '@/lib/testIds';
import { useRound } from '@/state/round';
import { useAuth } from '@/state/auth';
import { alpha, color, font, radius, space } from '@/theme/tokens';

/**
 * Names the criterion in the member's own words, matching the label on the
 * control they would go and change.
 */
const NARROWING_CRITERION_KEYS: Record<NarrowingCriterion, TranslationKey> = {
  age: 'filters.ageRange',
  height: 'filters.heightPlain',
  build: 'filters.bodyTypes',
  distance: 'filters.searchDistance',
  practice: 'filters.practice',
  timeline: 'filters.marriageTiming',
  children: 'filters.children',
  sect: 'filters.sect',
};

export default function DailyScreen() {
  const { t, isRTL } = useI18n();
  const { user } = useAuth();
  const readinessQuery = useQuery({
    queryKey: queryKeys.profileReadiness,
    queryFn: fetchMyProfileReadiness,
    enabled: !USE_MOCKS,
  });
  const {
    round,
    emptyReason,
    narrowingCriterion,
    nextSetCity,
    isLoading,
    error,
    refresh,
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
    releaseError,
    retryRelease,
    clearReleaseError,
    submit,
    submitting,
    submitted,
    waitingForConnection,
    submitError,
    reset,
    passCandidate,
    confirmPass,
    recordSoftSelect,
  } = useRound();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmLetGo, setConfirmLetGo] = useState(false);
  const [interestTargetId, setInterestTargetId] = useState<string | null>(null);
  // Premium keeps up to three, so which one comes first has to be asked. Free
  // members keep exactly one, which is their first choice by definition.
  const [firstChoiceOpen, setFirstChoiceOpen] = useState(false);
  const [firstChoiceId, setFirstChoiceId] = useState<string | null>(null);
  const [conductVisible, setConductVisible] = useState(false);
  // Which introduction to ask about before submitting, and whether the single
  // question this round allows has already been put.
  const [passAskId, setPassAskId] = useState<string | null>(null);
  const [passAsked, setPassAsked] = useState(false);
  const { shake, style: shakeStyle } = useCameraShake();
  const reducedMotion = useReducedMotion();
  const popPulse = useSharedValue(0);
  const roundId = round?.id;
  const introductionCount = round?.introductions.length;
  const conductMemberId = user?.id ?? 'mock-member';

  useEffect(() => {
    let active = true;
    void hasAcceptedConduct(conductMemberId)
      .then((accepted) => active && setConductVisible(!accepted))
      // Storage should not prevent a member from entering their daily round.
      .catch(() => active && setConductVisible(true));
    return () => { active = false; };
  }, [conductMemberId]);

  const acknowledgeConduct = useCallback(() => {
    setConductVisible(false);
    void acceptConduct(conductMemberId).catch(() => {
      // The current session remains acknowledged; the next launch can retry persistence.
    });
  }, [conductMemberId]);

  useEffect(() => {
    if (!roundId || introductionCount === undefined) return;
    trackProductEvent('daily_round_viewed', { introduction_count: introductionCount });
  }, [roundId, introductionCount]);

  // One question per round, so a new round earns a fresh one.
  useEffect(() => {
    setPassAsked(false);
    setPassAskId(null);
  }, [roundId]);

  useEffect(() => {
    if (!popMode || reducedMotion) {
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
  }, [popMode, popPulse, reducedMotion]);

  useEffect(() => {
    if (emptyReason === 'legal_consent_required') {
      router.replace('/legal-consent' as Href);
    }
  }, [emptyReason]);

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
      if (!reducedMotion) shake();
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      // The burst itself is owned by ArcCarousel, which knows where each face
      // sits and can fire the particles from exactly that point.
      release(id);
    },
    [reducedMotion, release, shake]
  );

  // Letting the last one go ends the round with nothing kept — irreversible,
  // hence its own confirmation.
  const handleLetGoFinal = useCallback(async () => {
    setConfirmLetGo(false);
    try {
      await submit([]);
    } catch {
      // The provider exposes the recoverable error without losing the round.
    }
  }, [submit]);

  const performSubmit = useCallback(async () => {
    // Before the keeps land, so the reading that produced it is still what the
    // round looked like. Swallows its own failures; it must never cost a submit.
    await recordSoftSelect();
    try {
      // The array order is the rank, so the named first choice leads.
      const ordered = interestTargetId
        ? [interestTargetId]
        : firstChoiceId
          ? [firstChoiceId, ...live.map((item) => item.id).filter((id) => id !== firstChoiceId)]
          : undefined;
      const mutual = await submit(ordered);
      if (mutual.length > 0 && mutual[0]) {
        router.push(`/match/${mutual[0]}`);
      }
    } catch {
      // The provider keeps the round open and exposes an actionable error.
    }
  }, [firstChoiceId, interestTargetId, live, recordSoftSelect, submit]);

  const handleSubmit = useCallback(async () => {
    setConfirmOpen(false);
    setFirstChoiceOpen(false);
    // Asked at most once per round, and only when one profile was read markedly
    // less than the rest. Most rounds never reach the dialog at all.
    if (!passAsked) {
      setPassAsked(true);
      const candidate = passCandidate();
      if (candidate) {
        setPassAskId(candidate);
        return;
      }
    }
    await performSubmit();
  }, [passAsked, passCandidate, performSubmit]);

  const passAskName =
    round?.introductions.find((item) => item.id === passAskId)?.profile.firstName
    ?? t('safety.thisPerson');

  // Either answer submits the round. Saying no is a real answer, not a dismissal
  // — it says the quick look was not a judgement, and that is worth recording as
  // much as the other way.
  const answerPass = useCallback(
    async (deliberate: boolean) => {
      const id = passAskId;
      setPassAskId(null);
      if (deliberate && id) await confirmPass(id);
      await performSubmit();
    },
    [confirmPass, passAskId, performSubmit]
  );

  const openInterestConfirmation = useCallback((id?: string) => {
    setInterestTargetId(id ?? null);
    // Sending to a whole set of more than one means we still do not know which
    // of them comes first, so ask before confirming.
    if (!id && live.length > 1) {
      setFirstChoiceId(null);
      setFirstChoiceOpen(true);
      return;
    }
    setConfirmOpen(true);
  }, [live.length]);

  /**
   * The card deck reports the exact profile it selected rather than only a
   * direction. This prevents rapid consecutive swipes from calculating from a
   * stale activeId and leaving the hero card and circle carousel one step apart.
   */
  const selectActiveIntroductionByProfileId = useCallback(
    (profileId: string) => {
      const introduction = live.find((item) => item.profile.id === profileId);
      if (introduction) setActive(introduction.id);
    },
    [live, setActive]
  );

  /** Opens the exact profile that is physically centred in the hero deck. */
  const openIntroductionByProfileId = useCallback(
    (profileId: string) => {
      const introduction = live.find((item) => item.profile.id === profileId);
      if (introduction) router.push(`/introduction/${introduction.id}`);
    },
    [live]
  );

  if (isLoading) {
    return (
      <Screen withTabBar style={isRTL ? styles.rtl : undefined}>
        <BrandHeader />
        <LoadingState label={t('daily.loading')} />
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen withTabBar style={isRTL ? styles.rtl : undefined}>
        <BrandHeader />
        <ErrorState
          title={t('daily.loadErrorTitle')}
          message={t('daily.loadErrorBody')}
          onRetry={refresh}
        />
      </Screen>
    );
  }

  if (
    (!round || round.introductions.length === 0)
    && (emptyReason === 'profile_not_ready' || (readinessQuery.data && !readinessQuery.data.ready))
  ) {
    const missingReadinessItems = readinessQuery.data?.missing ?? [];
    const onlyPreferencesMissing = missingReadinessItems.length === 1
      && missingReadinessItems[0] === 'preferences';
    return (
      <Screen withTabBar style={isRTL ? styles.rtl : undefined}>
        <BrandHeader />
        <View style={styles.readinessEmpty}>
          <EmptyState
            title={t('daily.readinessTitle')}
            message={t('daily.readinessBody')}
          />
          <Button
            label={t('daily.finishProfile')}
            onPress={() => router.push({ pathname: '/(tabs)/you', params: { tab: onlyPreferencesMissing ? 'private' : 'profile' } })}
          />
        </View>
      </Screen>
    );
  }

  if (emptyReason === 'legal_consent_required') {
    return (
      <Screen withTabBar style={isRTL ? styles.rtl : undefined}>
        <BrandHeader />
        <LoadingState label={t('legal.redirecting')} />
      </Screen>
    );
  }

  if (!round || round.introductions.length === 0) {
    const matchingInputsUnavailable = emptyReason === 'matching_inputs_unavailable';
    const awaitingTurn = emptyReason === 'awaiting_turn';
    const atMatchCapacity = emptyReason === 'at_match_capacity';
    // Only shown when the server named a criterion. Without one the message
    // would ask a member to loosen something without saying what, which is
    // worse than the established wording.
    const filtersTooNarrow =
      emptyReason === 'filters_too_narrow' && narrowingCriterion !== null;

    // A set that is built and simply has not opened yet. Every other message
    // below describes something being wrong; this one is a member waiting for
    // their own dawn, which is the app working exactly as intended.
    if (emptyReason === 'next_set_scheduled') {
      return (
        <Screen withTabBar style={isRTL ? styles.rtl : undefined}>
          <BrandHeader />
          <EmptyState
            title={t('daily.nextSetTitle')}
            message={
              nextSetCity
                ? t('daily.nextSetBody', { city: nextSetCity })
                : t('daily.nextSetBodyPlain')
            }
          />
        </Screen>
      );
    }

    if (filtersTooNarrow) {
      return (
        <Screen withTabBar style={isRTL ? styles.rtl : undefined}>
          <BrandHeader />
          <EmptyState
            title={t('daily.filtersTooNarrowTitle')}
            message={t('daily.filtersTooNarrowBody', {
              criterion: t(NARROWING_CRITERION_KEYS[narrowingCriterion]),
            })}
          />
        </Screen>
      );
    }

    const emptyTitle = awaitingTurn
      ? 'daily.awaitingTurnTitle'
      : atMatchCapacity
        ? 'daily.atCapacityTitle'
        : matchingInputsUnavailable
          ? 'daily.matchingInputsUnavailableTitle'
          : 'daily.noSuitableTitle';
    const emptyBody = awaitingTurn
      ? 'daily.awaitingTurnBody'
      : atMatchCapacity
        ? 'daily.atCapacityBody'
        : matchingInputsUnavailable
          ? 'daily.matchingInputsUnavailableBody'
          : 'daily.noSuitableBody';
    return (
      <Screen withTabBar style={isRTL ? styles.rtl : undefined}>
        <BrandHeader />
        <EmptyState
          title={t(emptyTitle)}
          message={t(emptyBody)}
        />
      </Screen>
    );
  }

  if (submitted) {
    return <SetCompleteState onReset={reset} waitingForConnection={waitingForConnection} />;
  }

  // The last introduction standing gets a named release instead of a toggle.
  // Pop mode itself is already off for the whole chosen zone — see RoundProvider —
  // so Premium members with three survivors keep their button but lose their pins.
  const isFinal = live.length === 1;
  const finalName = live[0]?.profile.firstName ?? '';

  return (
    <Screen withTabBar style={isRTL ? styles.rtl : undefined}>
      <BrandHeader />

      <View style={[styles.headline, isRTL && styles.rowReverse]}>
        <View style={styles.headlineText}>
          <Text variant="micro">
            {round.city ? t('daily.todayIn', { city: round.city }) : t('daily.today')}
          </Text>
          <Text variant="display" style={styles.title}>
            {t(
              round.introductions.length === 1
                ? 'daily.titleOne'
                : round.introductions.length === 2
                  ? 'daily.titleTwo'
                  : 'daily.title',
              { count: round.introductions.length }
            )}
          </Text>
        </View>
        {USE_MOCKS ? (
          <Pressable
            testID={testIds.daily.reset}
            accessibilityRole="button"
            accessibilityLabel={t('daily.demoResetLabel')}
            onPress={reset}
            style={styles.resetButton}
          >
            <Text style={styles.resetGlyph}>↺</Text>
          </Pressable>
        ) : null}
      </View>

      {releaseError ? (
        <InlineNotice
          message={t('daily.releaseError')}
          actionLabel={t('common.tryAgain')}
          onAction={retryRelease}
          onDismiss={clearReleaseError}
        />
      ) : null}
      {submitError ? (
        <InlineNotice message={t('daily.submitError')} />
      ) : null}

      <Animated.View style={[styles.stage, shakeStyle]}>
        {active ? (
          <HeroCard
            profiles={live.map((item) => item.profile)}
            activeId={active.profile.id}
            popMode={popMode}
            chosen={inChosenZone}
            onPress={openIntroductionByProfileId}
            onSwipe={selectActiveIntroductionByProfileId}
          />
        ) : null}

        {active ? (
          <View style={[styles.safetyOverlay, isRTL && styles.safetyOverlayRTL]}>
            <SafetyControl
              scope={{ kind: 'introduction', id: active.id }}
              memberName={active.profile.firstName}
              tone="dark"
              onBlocked={() => void refresh()}
            />
          </View>
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
            ? t('daily.oneLeft')
            : inChosenZone
              ? t('daily.kept', { count: live.length, limit: keepLimit })
              : t('daily.letGoMore', { count: remaining })}
        </Text>

        <View style={[styles.actions, isRTL && styles.rowReverse]}>
          {isFinal ? (
            <Button
              label={t('daily.letGoName', { name: finalName })}
              variant="secondary"
              dotColor="#CB4242"
              onPress={() => setConfirmLetGo(true)}
              style={styles.letGoAction}
            />
          ) : (
            <Pressable
              testID={testIds.daily.pop}
              accessibilityRole="switch"
              accessibilityState={{ checked: popMode, disabled: !canPop }}
              accessibilityLabel={t('daily.popLabel')}
              accessibilityHint={
                canPop
                  ? undefined
                  : t('daily.popUnavailable')
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
                {popMode ? t('daily.done') : t('daily.pop')}
              </Text>
            </Pressable>
          )}

          <Button
            testID={testIds.daily.primary}
            label={
              inChosenZone
                ? t('daily.sendInterest')
                : active
                  ? t('daily.readProfile', { name: active.profile.firstName })
                  : t('daily.readProfileFallback')
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

      <FirstChoiceDialog
        visible={firstChoiceOpen}
        introductions={live}
        selectedId={firstChoiceId}
        onSelect={setFirstChoiceId}
        onConfirm={() => void handleSubmit()}
        onCancel={() => {
          setFirstChoiceOpen(false);
          setFirstChoiceId(null);
        }}
      />

      <ConfirmDialog
        visible={confirmOpen}
        title={
          interestTargetId
            ? (() => {
                const name = live.find((item) => item.id === interestTargetId)?.profile.firstName;
                return name ? t('daily.sendToName', { name }) : t('daily.sendToPerson');
              })()
            : live.length === 1 && live[0]
            ? t('daily.sendToName', { name: live[0].profile.firstName })
            : t('daily.sendToSet')
        }
        body={t('daily.mutualOnly')}
        confirmLabel={t('daily.yesSend')}
        cancelLabel={t('daily.notYet')}
        onConfirm={() => void handleSubmit()}
        onCancel={() => {
          setConfirmOpen(false);
          setInterestTargetId(null);
        }}
      />

      <ConfirmDialog
        visible={confirmLetGo}
        title={t('daily.letGoQuestion', { name: finalName })}
        body={t('daily.letGoFinalBody')}
        confirmLabel={t('daily.letGo')}
        cancelLabel={t('daily.keepName', { name: finalName })}
        onConfirm={() => void handleLetGoFinal()}
        onCancel={() => setConfirmLetGo(false)}
      />
      {/* Asked about someone already let go, so the name comes from the whole
          round rather than from the survivors. */}
      <ConfirmDialog
        visible={passAskId !== null}
        title={t('daily.passTitle', { name: passAskName })}
        body={t('daily.passBody', { name: passAskName })}
        confirmLabel={t('daily.passConfirm')}
        cancelLabel={t('daily.passCancel')}
        testID={testIds.daily.confirmPass}
        onConfirm={() => void answerPass(true)}
        onCancel={() => void answerPass(false)}
      />

      <ConductAcknowledgement visible={conductVisible} onAccept={acknowledgeConduct} />
    </Screen>
  );
}

/**
 * The end of the round. Deliberately a dead end — no refresh, no "see more".
 * The reference is explicit that the empty state should close the session.
 */
function SetCompleteState({ onReset, waitingForConnection }: { onReset: () => void; waitingForConnection: boolean }) {
  const { t, isRTL } = useI18n();
  return (
    <Screen withTabBar style={isRTL ? styles.rtl : undefined}>
      <BrandHeader />
      <Animated.View entering={FadeIn.duration(300)} style={styles.complete}>
        <Text variant="micro">{t('daily.completeLabel')}</Text>
        <Text variant="display" center style={styles.completeTitle}>
          {t('daily.completeTitle')}
        </Text>
        <Text variant="bodySmall" center style={styles.completeBody}>
          {t('daily.completeBody')}
        </Text>
        {waitingForConnection ? <InlineNotice message={t('daily.waitingConnection')} /> : null}
        {USE_MOCKS ? (
          <Button
            label={t('daily.demoAgain')}
            variant="quiet"
            onPress={onReset}
            style={styles.completeReset}
          />
        ) : null}
      </Animated.View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  rtl: { direction: 'rtl' },
  rowReverse: { flexDirection: 'row-reverse' },
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
  safetyOverlay: { position: 'absolute', top: 12, right: 42, zIndex: 200 },
  safetyOverlayRTL: { right: undefined, left: 42 },

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
  readinessEmpty: { flex: 1, paddingHorizontal: 26, paddingBottom: 30 },
});
