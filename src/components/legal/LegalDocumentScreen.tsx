import { router } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { LEGAL_DOCUMENTS } from '@/data/legalDocuments';
import { useI18n } from '@/i18n';
import { color, space } from '@/theme/tokens';

/**
 * Renders the Terms or the Privacy Notice.
 *
 * These pages exist because the database already tells every member to read
 * them at halalmo.de/terms and halalmo.de/privacy before they can use the app.
 * Until now those addresses went nowhere, so people were accepting documents
 * they had no way to read.
 *
 * The routes are /terms and /privacy to match those addresses exactly. The URL
 * a member was promised is the fixed point here, not the folder layout.
 */
export function LegalDocumentScreen({ slug }: { slug: 'terms' | 'privacy' }) {
  const { isRTL } = useI18n();
  const doc = LEGAL_DOCUMENTS[slug];
  const other = slug === 'terms' ? 'privacy' : 'terms';

  return (
    <Screen>
      <ScrollView contentContainerStyle={[styles.content, isRTL && styles.rtl]}>
        <Text variant="microAccent">Halal Mode</Text>
        <Text variant="display" style={styles.title}>{doc.title}</Text>
        <Text variant="caption" style={styles.updated}>Last updated {doc.updated}</Text>
        <Text variant="body" style={styles.intro}>{doc.intro}</Text>

        {doc.sections.map((section) => (
          <View key={section.heading} style={styles.section}>
            <Text variant="label" style={styles.heading}>{section.heading}</Text>
            {section.body.map((line) => (
              <Text key={line} variant="bodySmall" style={styles.line}>{line}</Text>
            ))}
          </View>
        ))}

        <View style={styles.footer}>
          <Button
            label={other === 'privacy' ? 'Read the Privacy Notice' : 'Read the Terms'}
            variant="quiet"
            onPress={() => router.replace(`/${other}`)}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  rtl: { direction: 'rtl' },
  content: { padding: space.gutterWide, paddingBottom: space.xxl, gap: space.xs },
  title: { marginTop: space.xs },
  updated: { color: color.faint, marginTop: space.xs },
  intro: { marginTop: space.md, color: color.inkSoft },
  section: { marginTop: space.xl, gap: space.sm },
  heading: { color: color.ink },
  line: { color: color.inkSoft },
  footer: { marginTop: space.xxl },
});
