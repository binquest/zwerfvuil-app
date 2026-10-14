import { Stack } from 'expo-router';

// The map is full screen: no header, controls float over it.
export default function MapStack() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
    </Stack>
  );
}
