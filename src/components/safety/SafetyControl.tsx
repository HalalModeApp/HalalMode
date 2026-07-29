import { Ionicons } from '@expo/vector-icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import {
  blockConnectionMember,
  blockIntroductionMember,
  reportConnectionMember,
  reportIntroductionMember,
  type ReportReason,
} from '@/api/safety';
import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { useI18n } from '@/i18n';
import { queryKeys } from '@/lib/queryClient';
import { testIds } from '@/lib/testIds';
import { alpha, color, radius, shadow, space } from '@/theme/tokens';

export type SafetyScope =
  | { kind: 'connection'; id: string }
  | { kind: 'introduction'; id: string };

type SafetyAction =
  | { kind: 'report'; reason: ReportReason }
  | { kind: 'block' };
type SafetyView = 'closed' | 'menu' | 'report' | 'block' | 'reported' | 'blocked' | 'error';

const REPORT_REASONS: ReportReason[] = [
  'harassment',
  'misrepresentation',
  'safety_concern',
  'other',
];
const DANGER = '#9C2F2F';

export function SafetyControl({
  scope,
  memberName,
  onBlocked,
  tone = 'light',
}: {
  scope: SafetyScope;
  memberName?: string;
  onBlocked?: () => void;
  tone?: 'light' | 'dark';
}) {
  const { isRTL, t } = useI18n();
  const queryClient = useQueryClient();
  const [view, setView] = useState<SafetyView>('closed');
  const [lastAction, setLastAction] = useState<SafetyAction | null>(null);

  const mutation = useMutation({
    mutationFn: async (action: SafetyAction) => {
      if (action.kind === 'block') {
        if (scope.kind === 'connection') await blockConnectionMember(scope.id);
        else await blockIntroductionMember(scope.id);
        return action;
      }
      if (scope.kind === 'connection') {
        await reportConnectionMember(scope.id, action.reason);
      } else {
        await reportIntroductionMember(scope.id, action.reason);
      }
      return action;
    },
    onSuccess: async (action) => {
      if (action.kind === 'report') {
        setView('reported');
        return;
      }
      if (scope.kind === 'connection') {
        queryClient.removeQueries({ queryKey: queryKeys.messages(scope.id) });
        queryClient.removeQueries({ queryKey: queryKeys.connection(scope.id) });
        await queryClient.invalidateQueries({ queryKey: queryKeys.connections });
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.round });
      onBlocked?.();
      setView('blocked');
    },
    onError: () => setView('error'),
  });

  const run = (action: SafetyAction) => {
    setLastAction(action);
    mutation.mutate(action);
  };
  const close = () => {
    if (mutation.isPending) return;
    mutation.reset();
    setLastAction(null);
    setView('closed');
  };
  const finish = () => {
    const wasBlocked = view === 'blocked';
    close();
    if (!wasBlocked) return;
    router.replace(scope.kind === 'connection' ? '/(tabs)/connections' : '/(tabs)/daily');
  };

  return (
    <>
      <Pressable
        testID={testIds.safety.menu}
        accessibilityRole="button"
        accessibilityLabel={t('safety.menuA11y')}
        accessibilityHint={t('safety.menuHint')}
        onPress={() => setView('menu')}
        hitSlop={10}
        style={({ pressed }) => [
          styles.trigger,
          tone === 'dark' && styles.triggerDark,
          pressed && styles.pressed,
        ]}
      >
        <Ionicons
          name="ellipsis-horizontal"
          size={20}
          color={tone === 'dark' ? color.white : color.inkSoft}
        />
      </Pressable>

      <Modal
        visible={view !== 'closed'}
        transparent
        animationType="fade"
        onRequestClose={close}
        accessibilityViewIsModal
      >
        <View style={styles.scrim} accessibilityViewIsModal>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
            onPress={close}
            style={StyleSheet.absoluteFill}
          />
          <View
            testID={testIds.safety.sheet}
            accessibilityRole="alert"
            style={[styles.sheet, isRTL && styles.rtl]}
          >
            {view === 'menu' ? (
              <>
                <Text variant="displaySmall">{t('safety.title')}</Text>
                <Text variant="bodySmall" style={styles.body}>{t('safety.privateBody')}</Text>
                <SafetyOption
                  testID={testIds.safety.report}
                  label={t('safety.report')}
                  onPress={() => setView('report')}
                />
                <SafetyOption
                  testID={testIds.safety.block}
                  label={t('safety.block')}
                  destructive
                  onPress={() => setView('block')}
                />
                <Button label={t('common.close')} variant="quiet" onPress={close} />
              </>
            ) : null}

            {view === 'report' ? (
              <>
                <Text variant="displaySmall">{t('safety.reportTitle')}</Text>
                <Text variant="bodySmall" style={styles.body}>{t('safety.reportBody')}</Text>
                {REPORT_REASONS.map((reason) => (
                  <SafetyOption
                    key={reason}
                    testID={testIds.safety.reason(reason)}
                    label={t(`safety.reason.${reason}`)}
                    disabled={mutation.isPending}
                    onPress={() => run({ kind: 'report', reason })}
                  />
                ))}
                <Button label={t('common.back')} variant="quiet" onPress={() => setView('menu')} />
              </>
            ) : null}

            {view === 'block' ? (
              <>
                <Text variant="displaySmall">{t('safety.blockTitle')}</Text>
                <Text variant="bodySmall" style={styles.body}>
                  {t(
                    scope.kind === 'connection' ? 'safety.blockConnectionBody' : 'safety.blockIntroductionBody',
                    { name: memberName ?? t('safety.thisPerson') }
                  )}
                </Text>
                <Button
                  testID={testIds.safety.confirmBlock}
                  label={t('safety.blockConfirm')}
                  loading={mutation.isPending}
                  onPress={() => run({ kind: 'block' })}
                />
                <Button label={t('safety.cancel')} variant="quiet" onPress={() => setView('menu')} />
              </>
            ) : null}

            {view === 'reported' || view === 'blocked' ? (
              <>
                <Text variant="displaySmall">
                  {t(view === 'reported' ? 'safety.reportSuccessTitle' : 'safety.blockSuccessTitle')}
                </Text>
                <Text variant="bodySmall" style={styles.body}>
                  {t(view === 'reported' ? 'safety.reportSuccessBody' : 'safety.blockSuccessBody')}
                </Text>
                <Button testID={testIds.safety.done} label={t('safety.done')} onPress={finish} />
              </>
            ) : null}

            {view === 'error' ? (
              <>
                <Text variant="displaySmall">{t('safety.errorTitle')}</Text>
                <Text variant="bodySmall" style={styles.body}>{t('safety.errorBody')}</Text>
                <Button
                  testID={testIds.safety.retry}
                  label={t('common.tryAgain')}
                  loading={mutation.isPending}
                  disabled={!lastAction}
                  onPress={() => lastAction && mutation.mutate(lastAction)}
                />
                <Button label={t('safety.cancel')} variant="quiet" onPress={close} />
              </>
            ) : null}
          </View>
        </View>
      </Modal>
    </>
  );
}

function SafetyOption({
  label,
  onPress,
  testID,
  destructive,
  disabled,
}: {
  label: string;
  onPress: () => void;
  testID: string;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.option, pressed && styles.pressed]}
    >
      <Text style={destructive ? styles.destructive : undefined}>{label}</Text>
      <Ionicons name="chevron-forward" size={18} color={destructive ? DANGER : color.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  rtl: { direction: 'rtl' },
  trigger: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: alpha.line,
    backgroundColor: color.sandDeep,
  },
  triggerDark: { backgroundColor: 'rgba(10,10,10,0.45)', borderColor: 'rgba(252,252,251,0.3)' },
  pressed: { opacity: 0.62 },
  scrim: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(10,10,10,0.42)',
  },
  sheet: {
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: space.gutterWide,
    paddingTop: space.xxl,
    paddingBottom: 36,
    gap: space.sm,
    ...shadow.modal,
  },
  body: { marginBottom: space.md, color: color.muted },
  option: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: alpha.lineFaint,
  },
  destructive: { color: DANGER },
});
