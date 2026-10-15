// The skeleton of the one queue for everything that appears when the app opens
// (rules in src/game/moments.ts). Sources register a check that runs on a cold
// and a warm start and returns the moments they have (an approval, missed
// moments, a chest that is ready); the presenter shows them one at a time, in
// a fixed order, only on a tab screen without an open modal. A moment's screen
// calls done(key) when it closes (and only then marks it seen on the server).
//
// Phase 2: no sources yet. The approval celebration (phase 5), missed moments
// (phase 3), the notification question (phase 7) and the chest (phase 6) plug
// in here; the update prompt follows when it moves into the queue.
import { useSegments } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { appStart, canPresent, enqueueMoment, nextMoment, type AppStart, type Moment } from '@/game/moments';

export interface PresentableMoment extends Moment {
  /** Opens the moment's screen (or sheet). */
  present(): void;
}

type MomentCheck = (start: AppStart) => Promise<PresentableMoment[]>;

interface MomentsState {
  /** Queues a moment found outside a start (e.g. after a check-in). */
  enqueue(moment: PresentableMoment): void;
  /** The moment `key` was closed: the next one may come. */
  done(key: string): void;
  /** Registers a source; returns a function that removes it. */
  addSource(check: MomentCheck): () => void;
}

const MomentsContext = createContext<MomentsState | null>(null);

export function MomentsPresenter({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const segments = useSegments();
  // Queued moments; the one showing stays in the queue until it is done.
  const [queue, setQueue] = useState<PresentableMoment[]>([]);
  const presenting = useRef<string | null>(null);
  const sources = useRef(new Set<MomentCheck>());

  const enqueue = useCallback((moment: PresentableMoment) => setQueue((q) => enqueueMoment(q, moment)), []);

  const done = useCallback((key: string) => {
    if (presenting.current === key) presenting.current = null;
    setQueue((q) => q.filter((m) => m.key !== key));
  }, []);

  const addSource = useCallback((check: MomentCheck) => {
    sources.current.add(check);
    return () => {
      sources.current.delete(check);
    };
  }, []);

  // Cold start (the first active state while signed in), then every warm start.
  useEffect(() => {
    if (!enabled) return;
    const run = (start: AppStart) => {
      for (const check of sources.current) {
        check(start).then(
          (moments) => moments.forEach(enqueue),
          () => {
            // A source that fails shows nothing this time.
          },
        );
      }
    };
    let previous: string | null = null;
    const onChange = (state: string) => {
      const start = appStart(previous, state);
      previous = state;
      if (start) run(start);
    };
    onChange(AppState.currentState);
    const subscription = AppState.addEventListener('change', onChange);
    return () => subscription.remove();
  }, [enabled, enqueue]);

  // One at a time, only on a tab screen with nothing on top.
  useEffect(() => {
    if (!enabled || !canPresent(segments, presenting.current !== null)) return;
    const next = nextMoment(queue);
    if (!next) return;
    presenting.current = next.key;
    next.present();
  }, [enabled, segments, queue]);

  const value = useMemo(() => ({ enqueue, done, addSource }), [enqueue, done, addSource]);
  return <MomentsContext.Provider value={value}>{children}</MomentsContext.Provider>;
}

export function useMoments(): MomentsState {
  const context = useContext(MomentsContext);
  if (!context) throw new Error('useMoments outside MomentsPresenter');
  return context;
}
