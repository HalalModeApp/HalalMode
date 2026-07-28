import { Redirect, useLocalSearchParams } from 'expo-router';

/** Bare `/connection/:id` links land in the conversation. */
export default function ConnectionIndex() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={`/connection/${id}/chat`} />;
}
