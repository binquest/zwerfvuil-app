// The blocks of the approval celebration (celebrate.tsx, src/game/approval.ts)
// on the dark play surface: the headline, the total rolling from old to new,
// the points per source, a level-up, confirmed badges, unlocked avatars and,
// calm and last, the rejections with their reason. Everything is mounted with
// the screen and invisible until its `part` event (no native view mounts
// while it plays); `step` counts the blocks shown, so one shared value drives
// them all. With Reduce Motion a block only fades in.
import { memo, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import {
  approvalHeadline,
  approvedLine,
  levelUpLine,
  rejectedLine,
  sourceChips,
  type ApprovalPart,
  type UnseenResults,
} from '@/game/approval';
import { numberStyle, playColors, playType, shapes, spacing } from '@/theme';

import { Avatar } from './Avatar';
import { BadgeIcon } from './BadgeIcon';
import { GameNumber } from './GameNumber';

/** At most this many rejections listed; the rest as "en N meer". */
const MAX_REJECTED_LISTED = 5;

interface Props {
  results: UnseenResults;
  parts: readonly ApprovalPart[];
  /** How many blocks are in (fractions while one fades in). */
  step: SharedValue<number>;
  /** The total shown: points_before until the `count` event, then points_after. */
  total: number;
  countMs: number;
  reduceMotion: boolean;
}

const Part = memo(function Part({
  index,
  step,
  reduceMotion,
  children,
}: {
  index: number;
  step: SharedValue<number>;
  reduceMotion: boolean;
  children: ReactNode;
}) {
  const style = useAnimatedStyle(() => {
    const shown = Math.min(1, Math.max(0, step.get() - index));
    return { opacity: shown, transform: [{ translateY: reduceMotion ? 0 : (1 - shown) * 14 }] };
  });
  return <Animated.View style={[{ alignItems: 'center', gap: spacing.sm, alignSelf: 'stretch' }, style]}>{children}</Animated.View>;
});

function Label({ text, color = playColors.label }: { text: string; color?: string }) {
  return <Text style={[playType.label, { color, textAlign: 'center' }]}>{text}</Text>;
}

export function ApprovalBody({ results, parts, step, total, countMs, reduceMotion }: Props) {
  const headline = approvalHeadline(results);
  const gainedInHeadline = results.approvedCount > 0 && results.gained > 0;
  const rejectedListed = results.rejected.slice(-MAX_REJECTED_LISTED);
  const rejectedMore = results.rejectedCount - rejectedListed.length;

  const block = (part: ApprovalPart) => {
    switch (part) {
      case 'headline':
        return (
          <>
            <Text style={[playType.value, { color: playColors.text, fontWeight: '800', textAlign: 'center' }]} accessibilityRole="header">
              {gainedInHeadline ? 'Goedgekeurd!' : headline}
              {gainedInHeadline ? <Text style={{ color: playColors.chips, ...numberStyle }}>{` +${results.gained}`}</Text> : null}
            </Text>
            {approvedLine(results) ? <Text style={[playType.label, { color: playColors.muted }]}>{approvedLine(results)}</Text> : null}
          </>
        );
      case 'total':
        return (
          <>
            <GameNumber
              value={total}
              durationMs={countMs}
              style={[playType.total, { color: playColors.text, ...numberStyle }, total >= 10000 ? { transform: [{ scale: 0.75 }] } : null]}
            />
            <Label text="Totaal" />
          </>
        );
      case 'sources':
        return (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.xs }}>
            {sourceChips(results).map((chip) => (
              <View
                key={chip}
                style={{
                  height: shapes.badgeHeight,
                  borderRadius: shapes.badgeRadius,
                  paddingHorizontal: spacing.md,
                  justifyContent: 'center',
                  backgroundColor: playColors.chips,
                }}>
                <Text style={[playType.label, { color: playColors.text }]}>{chip}</Text>
              </View>
            ))}
          </View>
        );
      case 'level':
        return (
          <>
            <Label text="Level up" color={playColors.gold} />
            <Text style={[playType.value, { color: playColors.gold, fontWeight: '800', textAlign: 'center' }]}>{levelUpLine(results)}</Text>
          </>
        );
      case 'badges':
        return (
          <>
            <Label text={results.badges.length === 1 ? 'Badge bevestigd' : 'Badges bevestigd'} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.md }}>
              {results.badges.map((badge) => (
                <View key={badge.key} style={{ alignItems: 'center', gap: spacing.xs, width: 88 }}>
                  <BadgeIcon badge={badge} size={48} scheme="dark" decorative />
                  <Text numberOfLines={2} style={[playType.label, { color: playColors.text, textAlign: 'center', textTransform: 'none' }]}>
                    {badge.name}
                  </Text>
                </View>
              ))}
            </View>
          </>
        );
      case 'avatars':
        return (
          <>
            <Label text="Ontgrendeld" />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.md }}>
              {results.avatars.map((avatar) => (
                <View key={avatar.key} style={{ alignItems: 'center', gap: spacing.xs, width: 88 }}>
                  <Avatar avatarKey={avatar.key} size={48} decorative />
                  <Text numberOfLines={1} style={[playType.label, { color: playColors.text, textTransform: 'none' }]}>
                    {avatar.name}
                  </Text>
                </View>
              ))}
            </View>
          </>
        );
      case 'rejected':
        return (
          <View
            style={{
              alignSelf: 'stretch',
              gap: spacing.xs,
              padding: spacing.md,
              borderRadius: shapes.chunkyRadius,
              borderCurve: 'continuous',
              backgroundColor: 'rgba(0,0,0,0.25)',
            }}>
            <Label text={results.rejectedCount === 1 ? '1 inworp afgewezen' : `${results.rejectedCount} inworpen afgewezen`} color={playColors.muted} />
            {rejectedListed.map((r) => (
              <Text key={r.checkinId} style={{ color: playColors.muted, textAlign: 'center' }}>
                {rejectedLine(r)}
              </Text>
            ))}
            {rejectedMore > 0 ? <Text style={{ color: playColors.muted, textAlign: 'center' }}>{`en ${rejectedMore} meer`}</Text> : null}
          </View>
        );
    }
  };

  return (
    <View style={{ alignItems: 'center', gap: spacing.xl, alignSelf: 'stretch' }}>
      {parts.map((part, index) => (
        <Part key={part} index={index} step={step} reduceMotion={reduceMotion}>
          {block(part)}
        </Part>
      ))}
    </View>
  );
}
