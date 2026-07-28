import { Link } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { color } from '@/theme/tokens';

export default function NotFound() {
  return (
    <Screen>
      <View style={styles.body}>
        <Text variant="micro">Nothing here</Text>
        <Text variant="display" center>
          That page has closed.
        </Text>
        <Link href="/(tabs)/daily" style={styles.link}>
          <Text variant="bodySmall" tone="gold">
            Back to today’s set
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
});
