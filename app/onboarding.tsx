import { useState, type ComponentProps } from 'react';
import { Alert, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { requireSupabase } from '@/lib/supabase';
import { useAuth } from '@/state/auth';
import { color, radius, space } from '@/theme/tokens';

type Gender = 'male' | 'female';

export default function OnboardingScreen() {
  const { refreshProfileStatus } = useAuth();
  const [name, setName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [gender, setGender] = useState<Gender | null>(null);
  const [saving, setSaving] = useState(false);

  const complete = async () => {
    if (!gender || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
      Alert.alert('Check your details', 'Choose a gender and enter your date of birth as YYYY-MM-DD.');
      return;
    }
    setSaving(true);
    try {
      const { error } = await requireSupabase().rpc('complete_onboarding', {
        p_name: name,
        p_first_name: firstName,
        p_birth_date: birthDate,
        p_gender: gender,
        p_city: city,
        p_country: country,
      });
      if (error) throw error;
      await refreshProfileStatus();
    } catch (error) {
      Alert.alert('Could not finish setup', error instanceof Error ? error.message : 'Please check your details and try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text variant="microAccent">Profile setup</Text>
        <Text variant="display" style={styles.title}>A few essentials.</Text>
        <Text variant="body" style={styles.copy}>These basics help us build a private, appropriate introduction set.</Text>
        <View style={styles.form}>
          <Field label="Full name" value={name} onChangeText={setName} />
          <Field label="First name" value={firstName} onChangeText={setFirstName} />
          <Field label="Date of birth" value={birthDate} onChangeText={setBirthDate} placeholder="YYYY-MM-DD" />
          <Text variant="label">Gender</Text>
          <View style={styles.genderRow}>
            {(['female', 'male'] as const).map((option) => (
              <Button key={option} label={option === 'female' ? 'Woman' : 'Man'} variant={gender === option ? 'primary' : 'secondary'} block={false} onPress={() => setGender(option)} />
            ))}
          </View>
          <Field label="City" value={city} onChangeText={setCity} />
          <Field label="Country" value={country} onChangeText={setCountry} />
          <Button label="Finish setup" loading={saving} onPress={() => void complete()} style={styles.finish} />
        </View>
      </ScrollView>
    </Screen>
  );
}

function Field({ label, ...props }: { label: string } & ComponentProps<typeof TextInput>) {
  return <View style={styles.field}><Text variant="label">{label}</Text><TextInput {...props} placeholderTextColor={color.faintest} style={styles.input} /></View>;
}

const styles = StyleSheet.create({
  content: { padding: space.gutterWide, paddingBottom: 48 },
  title: { marginTop: 8, fontSize: 31, lineHeight: 38 },
  copy: { marginTop: 9 },
  form: { marginTop: 28, gap: 14 },
  field: { gap: 7 },
  input: { height: 50, borderWidth: 1, borderColor: '#D9D6CE', borderRadius: radius.lg, paddingHorizontal: 14, color: color.ink, fontFamily: 'Beiruti_400Regular', fontSize: 16 },
  genderRow: { flexDirection: 'row', gap: 10 },
  finish: { marginTop: 10 },
});
