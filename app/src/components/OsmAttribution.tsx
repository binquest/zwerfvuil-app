import * as WebBrowser from 'expo-web-browser';
import { Pressable, Text, type StyleProp, type ViewStyle } from 'react-native';

import { GlassPanel } from '@/components/GlassPanel';
import { colors, type } from '@/theme';

export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

/** Required attribution for the OSM bin data; opens the licence page in Safari. */
export function OsmAttribution({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <GlassPanel interactive style={[{ borderRadius: 999 }, style]}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="© OpenStreetMap contributors, open de licentiepagina"
        onPress={() => WebBrowser.openBrowserAsync(OSM_COPYRIGHT_URL)}
        hitSlop={8}
        style={{ paddingHorizontal: 10, paddingVertical: 4 }}>
        <Text style={[type.caption, { color: colors.secondaryLabel }]}>© OpenStreetMap</Text>
      </Pressable>
    </GlassPanel>
  );
}
