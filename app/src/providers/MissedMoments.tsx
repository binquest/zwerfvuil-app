// The first real source of the MomentsPresenter: discoveries and milestones
// the player has not seen (my_unseen), e.g. because the app closed during a
// reveal. On a cold or warm start it queues one 'missed' moment; when the
// presenter shows it, it asks the server again (a reveal may have marked them
// seen meanwhile) and opens the celebration, which marks them seen on close.
import { router } from 'expo-router';
import { useEffect } from 'react';

import { setPendingCelebration } from '@/game/celebration';
import { fetchMyUnseen } from '@/lib/api';
import { useMoments } from '@/providers/MomentsPresenter';

export function MissedMoments() {
  const { addSource, done } = useMoments();

  useEffect(
    () =>
      addSource(async () => {
        const unseen = await fetchMyUnseen();
        if (unseen.moments.length === 0) return [];
        const key = `missed:${unseen.asOf}`;
        const present = () => {
          fetchMyUnseen().then(
            (now) => {
              if (now.moments.length === 0) {
                done(key);
                return;
              }
              setPendingCelebration({
                kind: 'missed',
                moments: now.moments,
                total: now.total,
                asOf: now.asOf,
                preview: false,
                onClose: () => done(key),
              });
              router.push('/celebrate');
            },
            () => done(key),
          );
        };
        return [{ kind: 'missed', key, present }];
      }),
    [addSource, done],
  );

  return null;
}
