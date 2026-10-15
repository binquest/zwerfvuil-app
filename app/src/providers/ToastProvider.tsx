// Toasts above native modals (docs/GAMIFICATION.md, chapter 5). The provider is
// only a queue; the tabs and every modal screen render their own
// <ToastViewport/>, and the one on top shows the toast (see src/game/toasts.ts).
// The reveal and the celebrations render <ToastViewport hold/>: no general
// toasts there, they wait until it closes. VoiceOver reads every toast.
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Text, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassPanel } from '@/components/GlassPanel';
import { activeViewport, TOAST_MS, type Toast, type Viewport } from '@/game/toasts';
import { colors, spacing, type } from '@/theme';

interface ToastState {
  show(toast: Omit<Toast, 'id'>): void;
  /** The toast to show, on the viewport `active`. */
  current: Toast | null;
  active: number | null;
  /** Puts viewport `id` on top; returns a function that removes it. */
  register(id: number, hold: boolean): () => void;
}

let lastViewportId = 0;

const ToastContext = createContext<ToastState | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Toast[]>([]);
  const [viewports, setViewports] = useState<Viewport[]>([]);
  const lastToastId = useRef(0);

  const active = activeViewport(viewports);
  const current = active === null ? null : (queue[0] ?? null);

  // A toast stays TOAST_MS once it is visible, then the next one comes.
  useEffect(() => {
    if (!current) return;
    AccessibilityInfo.announceForAccessibilityWithOptions(current.message ? `${current.title}. ${current.message}` : current.title, {
      queue: true,
    });
    const timer = setTimeout(() => setQueue((q) => q.filter((t) => t.id !== current.id)), TOAST_MS);
    return () => clearTimeout(timer);
  }, [current]);

  const show = useCallback((toast: Omit<Toast, 'id'>) => {
    lastToastId.current += 1;
    const id = lastToastId.current;
    setQueue((q) => [...q, { ...toast, id }]);
  }, []);

  const register = useCallback((id: number, hold: boolean) => {
    setViewports((v) => [...v, { id, hold }]);
    return () => setViewports((v) => v.filter((viewport) => viewport.id !== id));
  }, []);

  const value = useMemo(() => ({ show, current, active, register }), [show, current, active, register]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

/** show({ title, message?, systemImage? }): queues a toast for the screen on top. */
export function useToast(): Pick<ToastState, 'show'> {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast outside ToastProvider');
  return context;
}

/** Where toasts appear on this surface; `hold` keeps them away (reveal, celebrations). */
export function ToastViewport({ hold = false }: { hold?: boolean }) {
  const context = useContext(ToastContext);
  const insets = useSafeAreaInsets();
  const [mine] = useState(() => ++lastViewportId);
  const register = context?.register;

  useEffect(() => register?.(mine, hold), [register, mine, hold]);

  if (!context || context.active !== mine || !context.current) return null;
  const toast = context.current;
  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', top: insets.top + spacing.sm, left: spacing.lg, right: spacing.lg, alignItems: 'center' }}>
      <Animated.View key={toast.id} entering={FadeInUp.reduceMotion(ReduceMotion.System)} exiting={FadeOutUp.reduceMotion(ReduceMotion.System)}>
        <GlassPanel style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg }}>
          {toast.systemImage ? <SymbolView name={toast.systemImage as SFSymbol} size={20} tintColor={colors.tint} /> : null}
          <View style={{ flexShrink: 1 }}>
            <Text style={[type.headline, { color: colors.label }]}>{toast.title}</Text>
            {toast.message ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{toast.message}</Text> : null}
          </View>
        </GlassPanel>
      </Animated.View>
    </View>
  );
}
