// The question for notifications, a source of the MomentsPresenter
// (docs/GAMIFICATION.md, chapter 5 and phase 7): only after the first
// successful check-in, first our own explanation (/notifications), and only
// then the system prompt. Asked once per device; "Niet nu" leaves the switch
// in Instellingen. It comes at a start (a player who already checked in) or
// right after the first check-in, when the reveal has closed.
import { router, useSegments } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

import { canPresent } from '@/game/moments';
import { markPermissionAsked, permissionAsked } from '@/notifications/memory';
import { setPromptOnClose } from '@/notifications/prompt';
import { notificationPermission } from '@/notifications/scheduler';
import { useGame } from '@/providers/GameProvider';
import { useMoments, type PresentableMoment } from '@/providers/MomentsPresenter';

const KEY = 'notifications';

async function shouldAsk(checkins: number | undefined): Promise<boolean> {
  if (!checkins || checkins < 1 || permissionAsked()) return false;
  return (await notificationPermission()) === 'undetermined';
}

export function NotificationsMoment() {
  const { addSource, enqueue, done } = useMoments();
  const { state, refresh } = useGame();
  const segments = useSegments();
  const segmentsNow = useRef<readonly string[]>(segments);
  useEffect(() => {
    segmentsNow.current = segments;
  }, [segments]);

  const moment = useCallback(
    (): PresentableMoment => ({
      kind: 'notifications',
      key: KEY,
      present: () => {
        // Asked meanwhile, or a modal is open: nothing (it comes back at the next start).
        if (permissionAsked() || !canPresent(segmentsNow.current, false)) {
          done(KEY);
          return;
        }
        markPermissionAsked();
        setPromptOnClose(() => done(KEY));
        router.push('/notifications');
      },
    }),
    [done],
  );

  // At a start: the state of this start (shared with the GameProvider's request).
  useEffect(
    () =>
      addSource(async () => {
        const fresh = await refresh();
        return (await shouldAsk(fresh?.stats?.checkins)) ? [moment()] : [];
      }),
    [addSource, refresh, moment],
  );

  // Right after the first check-in: the count goes from 0 to 1 in this session.
  const checkins = state?.stats?.checkins;
  const before = useRef<number | undefined>(undefined);
  useEffect(() => {
    const previous = before.current;
    before.current = checkins;
    if (previous !== 0 || !checkins) return;
    let active = true;
    shouldAsk(checkins).then((ask) => {
      if (active && ask) enqueue(moment());
    });
    return () => {
      active = false;
    };
  }, [checkins, enqueue, moment]);

  return null;
}
