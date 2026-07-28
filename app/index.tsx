import { Redirect } from 'expo-router';

/** Today's set is the home screen. There is nowhere else to land. */
export default function Index() {
  return <Redirect href="/(tabs)/daily" />;
}
