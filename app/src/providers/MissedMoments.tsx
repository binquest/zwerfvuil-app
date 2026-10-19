// The sources of the MomentsPresenter that come from my_unseen: the
// decisions since the last visit (the approval celebration, with a level-up)
// and the discoveries, milestones and badges the player has not seen (e.g.
// because the app closed during a reveal). On a cold or warm start it queues
// an 'approval' and/or a 'missed' moment (the presenter shows approval first);
// when the presenter shows one, it asks the server again (a reveal may have
// marked the moments seen meanwhile) and opens the celebration, which marks
// them seen on close. If a camera, reveal or sheet opened while it asked, it
// shows nothing (the moment comes back on the next start).
import { router, useSegments } from 'expo-router';
import { useEffect, useRef } from 'react';

import { hasResults } from '@/game/approval';
import { setPendingCelebration } from '@/game/celebration';
import { canPresent, unseenMomentKinds } from '@/game/moments';
import { fetchMyUnseen } from '@/lib/api';
import { useMoments, type PresentableMoment } from '@/providers/MomentsPresenter';

export function MissedMoments() {
  const { addSource, done } = useMoments();
  const segments = useSegments();
  const segmentsNow = useRef<readonly string[]>(segments);
  useEffect(() => {
    segmentsNow.current = segments;
  }, [segments]);

  useEffect(
    () =>
      addSource(async () => {
        const unseen = await fetchMyUnseen();
        return unseenMomentKinds(unseen).map((kind): PresentableMoment => {
          const key = `${kind}:${unseen.asOf}`;
          const present = () => {
            fetchMyUnseen().then(
              (now) => {
                if (!canPresent(segmentsNow.current, false)) {
                  done(key);
                  return;
                }
                if (kind === 'approval' && hasResults(now.results)) {
                  setPendingCelebration({ kind: 'approval', results: now.results, asOf: now.asOf, preview: false, onClose: () => done(key) });
                } else if (kind === 'missed' && now.moments.length > 0) {
                  setPendingCelebration({
                    kind: 'missed',
                    moments: now.moments,
                    total: now.total,
                    asOf: now.asOf,
                    preview: false,
                    onClose: () => done(key),
                  });
                } else {
                  done(key);
                  return;
                }
                router.push('/celebrate');
              },
              () => done(key),
            );
          };
          return { kind, key, present };
        });
      }),
    [addSource, done],
  );

  return null;
}
