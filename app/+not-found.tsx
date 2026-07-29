import { Link } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useI18n } from '@/i18n';
import { color } from '@/theme/tokens';

export default function NotFound() {
  const { isRTL, t } = useI18n();

  return (
    <Screen style={isRTL ? styles.rtl : undefined}>
      <View style={styles.body}>
        <Text variant="micro">{t('notFound.eyebrow')}</Text>
        <Text variant="display" center>
          {t('notFound.title')}
        </Text>
        <Link
          accessibilityRole="link"
          accessibilityLabel={t('notFound.returnToday')}
          href="/(tabs)/daily"
          style={styles.link}
          testID="not-found-return-today"
        >
          <Text variant="bodySmall" tone="gold">
            {t('notFound.returnToday')}
          </Text>
        </Link>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingHorizontal: 40,
    backgroundColor: color.surface,
  },
  link: { marginTop: 6 },
  rtl: { direction: 'rtl' },
});
