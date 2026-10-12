import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';

import { photoUrl } from '@/lib/api';
import { colors } from '@/theme';

/** Shows a photo from a private bucket through a short-lived signed URL. */
export function PrivatePhoto({ bucket, path }: { bucket: 'checkin-photos' | 'report-photos'; path: string }) {
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    photoUrl(bucket, path)
      .then((url) => active && setUri(url))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [bucket, path]);

  return (
    <View style={styles.box}>
      {failed ? (
        <Text style={styles.error}>Foto niet beschikbaar</Text>
      ) : uri ? (
        <Image source={{ uri }} style={styles.image} resizeMode="cover" onError={() => setFailed(true)} />
      ) : (
        <ActivityIndicator color={colors.primary} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    height: 240,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#eceeec',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: { width: '100%', height: '100%' },
  error: { color: colors.muted },
});
