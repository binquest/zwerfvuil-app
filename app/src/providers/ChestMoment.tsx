// The chest source of the MomentsPresenter (docs/GAMIFICATION.md, chapter 5):
// on a cold or warm start, a daily chest that is ready and was not announced
// on this device yet opens the chest screen (last in the queue, after the
// approval celebration and the missed moments). A chest that a celebration
// already opened counts as announced (the chest screen remembers it), so it
// never shows twice; "Later" leaves it on Today with the tab badge.
import { router, useSegments } from 'expo-router';
import { useEffect, useRef } from 'react';

import { setChestOnClose } from '@/game/chest';
import { canPresent } from '@/game/moments';
import { chestAnnounced } from '@/game/todayMemory';
import { fetchMyGameState } from '@/lib/api';
import { useMoments, type PresentableMoment } from '@/providers/MomentsPresenter';

export function ChestMoment() {
  const { addSource, done } = useMoments();
  const segments = useSegments();
  const segmentsNow = useRef<readonly string[]>(segments);
  useEffect(() => {
    segmentsNow.current = segments;
  }, [segments]);

  useEffect(
    () =>
      addSource(async () => {
        const state = await fetchMyGameState();
        const day = state.today?.chestsReady.find((d) => !chestAnnounced(d));
        if (!day) return [];
        const key = `chest:${day}`;
        const present = () => {
          // Opened or announced meanwhile (a celebration led to it), or a modal is open: nothing.
          if (chestAnnounced(day) || !canPresent(segmentsNow.current, false)) {
            done(key);
            return;
          }
          setChestOnClose(() => done(key));
          router.push({ pathname: '/chest', params: { day } });
        };
        const moment: PresentableMoment = { kind: 'chest', key, present };
        return [moment];
      }),
    [addSource, done],
  );

  return null;
}
