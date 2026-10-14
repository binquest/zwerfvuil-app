import { SymbolView } from 'expo-symbols';
import type { ColorValue } from 'react-native';
import { View } from 'react-native';

/** A round map marker with an SF Symbol, like the place markers in Apple Maps. */
export function MapPin({
  color,
  selected = false,
  symbol = 'trash.fill',
}: {
  color: ColorValue;
  selected?: boolean;
  symbol?: 'trash.fill' | 'mappin';
}) {
  const size = selected ? 40 : 28;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        borderWidth: 2,
        borderColor: 'white',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
      }}>
      <SymbolView name={symbol} size={selected ? 19 : 13} tintColor="white" weight="semibold" />
    </View>
  );
}
