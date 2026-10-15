import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { photoUrl } from '@/lib/api';
import { colors, radius, type } from '@/theme';

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
    <View
      style={{
        aspectRatio: 4 / 3,
        borderRadius: radius.control,
        borderCurve: 'continuous',
        overflow: 'hidden',
        backgroundColor: colors.fill,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
      }}>
      {failed ? (
        <>
          <SymbolView name="photo.badge.exclamationmark" size={28} tintColor={colors.secondaryLabel} />
          <Text style={[type.footnote, { color: colors.secondaryLabel }]}>Foto niet beschikbaar</Text>
        </>
      ) : uri ? (
        <Image
          source={{ uri }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={200}
          onError={() => setFailed(true)}
        />
      ) : (
        <ActivityIndicator />
      )}
    </View>
  );
}
