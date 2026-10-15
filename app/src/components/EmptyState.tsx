import { Host } from '@expo/ui';
import { Button, ContentUnavailableView, VStack } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, frame, padding, tint } from '@expo/ui/swift-ui/modifiers';
import type { StyleProp, ViewStyle } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';

import { colors } from '@/theme';

export interface EmptyStateAction {
  label: string;
  onPress: () => void;
  /** The main action: a filled button in the app green. */
  prominent?: boolean;
}

/**
 * The system "nothing here" view (ContentUnavailableView) with optional
 * buttons, for empty lists, errors and permission screens.
 */
export function EmptyState({
  title,
  systemImage,
  description,
  actions = [],
  style,
}: {
  title: string;
  systemImage: SFSymbol;
  description?: string;
  actions?: EmptyStateAction[];
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Host style={style ?? { flex: 1 }}>
      <VStack spacing={12} modifiers={[padding({ horizontal: 24, bottom: 24 })]}>
        <ContentUnavailableView title={title} systemImage={systemImage} description={description} />
        {actions.map((action) => (
          <Button
            key={action.label}
            label={action.label}
            onPress={action.onPress}
            modifiers={[
              buttonStyle(action.prominent ? 'glassProminent' : 'glass'),
              controlSize('large'),
              tint(colors.tint),
              frame({ maxWidth: 420 }),
            ]}
          />
        ))}
      </VStack>
    </Host>
  );
}
