import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { fetchMyBlockedMembers, unblockMyMember } from '@/api/safety';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Text } from '@/components/ui/Text';
import { useI18n } from '@/i18n';
import { color, font, radius, space } from '@/theme/tokens';
import { testIds } from '@/lib/testIds';

export function BlockedMembersSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t, isRTL } = useI18n();
  const queryClient = useQueryClient();
  const blockedQuery = useQuery({
    queryKey: ['blocked-members'],
    queryFn: fetchMyBlockedMembers,
    enabled: visible,
  });
  const unblock = useMutation({
    mutationFn: unblockMyMember,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['blocked-members'] }),
    onError: () => Alert.alert(t('settings.blockedErrorTitle'), t('settings.blockedErrorBody')),
  });

  const confirmUnblock = (id: string, firstName: string) => {
    Alert.alert(t('settings.unblockTitle'), t('settings.unblockBody', { name: firstName }), [
      { text: t('settings.notNow'), style: 'cancel' },
      { text: t('settings.unblockAction'), onPress: () => unblock.mutate(id) },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, isRTL && styles.rtl]}>
          <View style={[styles.header, isRTL && styles.rowReverse]}>
            <View style={styles.headerText}>
              <Text testID={testIds.settings.blockedTitle} variant="displaySmall">{t('settings.blocked')}</Text>
              <Text variant="caption">{t('settings.blockedSheetBody')}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={t('common.dismiss')} onPress={onClose} style={styles.close}>
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>

          {blockedQuery.isPending ? <ActivityIndicator color={color.ink} style={styles.loading} /> : null}
          {blockedQuery.isError ? (
            <View style={styles.empty}>
              <Text variant="bodySmall">{t('settings.blockedLoadError')}</Text>
              <Button label={t('common.tryAgain')} variant="secondary" onPress={() => void blockedQuery.refetch()} />
            </View>
          ) : null}
          {!blockedQuery.isPending && !blockedQuery.isError && blockedQuery.data?.length === 0 ? (
            <View style={styles.empty}><Text variant="bodySmall">{t('settings.blockedEmpty')}</Text></View>
          ) : null}
          {blockedQuery.data?.length ? (
            <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
              {blockedQuery.data.map((member) => (
                <Card key={member.id} tone="filled" style={styles.member}>
                  <View style={styles.memberText}>
                    <Text variant="label">{member.firstName}</Text>
                    <Text variant="caption">{[member.city, member.country].filter(Boolean).join(', ')}</Text>
                  </View>
                  <Button
                    label={t('settings.unblockAction')}
                    variant="secondary"
                    block={false}
                    loading={unblock.isPending && unblock.variables === member.id}
                    onPress={() => confirmUnblock(member.id, member.firstName)}
                  />
                </Card>
              ))}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(10, 10, 10, 0.38)' },
  sheet: { maxHeight: '78%', backgroundColor: color.surface, borderTopLeftRadius: radius.panel, borderTopRightRadius: radius.panel, padding: space.xl, gap: 16 },
  rtl: { direction: 'rtl' },
  rowReverse: { flexDirection: 'row-reverse' },
  header: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between' },
  headerText: { flex: 1, gap: 4 },
  close: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontFamily: font.body, fontSize: 28, color: color.ink },
  loading: { paddingVertical: 30 },
  empty: { paddingVertical: 28, gap: 14, alignItems: 'center' },
  list: { gap: 10, paddingBottom: 16 },
  member: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  memberText: { flex: 1, gap: 3 },
});
