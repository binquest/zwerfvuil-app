import { Linking, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

/** Required attribution for the OSM bin data, linking to the licence page. */
export function OsmAttribution({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel="© OpenStreetMap contributors, open de licentiepagina"
      onPress={() => Linking.openURL(OSM_COPYRIGHT_URL)}
      hitSlop={8}
      style={[styles.box, style]}>
      <Text style={styles.text}>© OpenStreetMap contributors</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: 'rgba(255,255,255,0.85)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  text: { fontSize: 11, color: '#1b1b1b', textDecorationLine: 'underline' },
});
