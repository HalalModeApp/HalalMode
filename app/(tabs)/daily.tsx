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
import { HeroCard } from '@/components/introductions/HeroCard';
import { BrandHeader } from '@/components/navigation/BrandHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, InlineNotice, LoadingState } from '@/components/ui/AsyncState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useCameraShake } from '@/hooks/useCameraShake';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useI18n } from '@/i18n';
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
  } = useRound();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmLetGo, setConfirmLetGo] = useState(false);
  const [interestTargetId, setInterestTargetId] = useState<string | null>(null);
  const [conductVisible, setConductVisible] = useState(false);
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

  const handleSubmit = useCallback(async () => {
    setConfirmOpen(false);
    try {
      const mutual = await submit(interestTargetId ? [interestTargetId] : undefined);
      if (mutual.length > 0 && mutual[0]) {
        router.push(`/match/${mutual[0]}`);
      }
    } catch {
      // The provider keeps the round open and exposes an actionable error.
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
    return (
      <Screen withTabBar style={isRTL ? styles.rtl : undefined}>
        <BrandHeader />
        <EmptyState
          title={t(matchingInputsUnavailable
            ? 'daily.matchingInputsUnavailableTitle'
            : 'daily.noSuitableTitle')}
          message={t(matchingInputsUnavailable
            ? 'daily.matchingInputsUnavailableBody'
            : 'daily.noSuitableBody')}
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
          <Text variant="micro">{t('daily.today')}</Text>
          <Text variant="display" style={styles.title}>
            {t('daily.title', { count: round.introductions.length })}
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
