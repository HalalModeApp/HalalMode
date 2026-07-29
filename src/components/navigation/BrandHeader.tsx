import { StyleSheet, View } from 'react-native';

import { Wordmark } from '@/components/brand/Wordmark';
import { Text } from '@/components/ui/Text';
import { useI18n } from '@/i18n';
import { useSession } from '@/state/session';
import { color, font } from '@/theme/tokens';

/** The wordmark strip that tops every primary screen in the reference. */
export function BrandHeader() {
  const { tier } = useSession();
  const { t } = useI18n();

  return (
    <View style={styles.header}>
      <Wordmark width={110} />
      {tier === 'plus' ? (
        // Beiruti rather than the logo's own letterforms, and gold rather than
        // ink — so it reads as a tier badge attached to the mark, not as part
        // of the mark itself.
        <Text testID="membership-premium-badge" accessibilityLabel={t('settings.premium')} style={styles.plus}>{t('settings.premiumBadge')}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    height: 34,
    paddingHorizontal: 26,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    paddingBottom: 4,
  },
  plus: {
    fontFamily: font.bodySemi,
    fontSize: 15,
    lineHeight: 17,
    letterSpacing: 0.2,
    color: color.gold,
  },
});
