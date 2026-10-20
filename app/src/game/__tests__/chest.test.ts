import { describe, expect, it } from '@jest/globals';
import { buildCelebrationTimeline, hasRevealNews, revealNews } from '../celebration';
import {
  buildChestOpenTimeline,
  buildChestShakeTimeline,
  CHEST_SHAKE_MS,
  CHEST_WAVE_MS,
  chestSummary,
  isRareFind,
  parseChestOpened,
  rewardRarity,
  setChestOnClose,
  setPendingChestPreview,
  takeChestOnClose,
  takePendingChestPreview,
} from '../chest';
import { parseCheckinGame, parseUnseen, summarizeMoments } from '../discoveries';

const AVATARS = [
  { key: 'maan', rarity: 'epic' as const },
  { key: 'regenboog', rarity: 'legendary' as const },
];

describe('the chest timelines', () => {
  it('shakes in three waves with a haptic each, the rattle once, within the shake', () => {
    const events = buildChestShakeTimeline({ reduceMotion: false });
    expect(events.filter((e) => e.type === 'sound').map((e) => e.type === 'sound' && e.id)).toEqual(['chest_rattle']);
    expect(events.filter((e) => e.type === 'haptic').map((e) => e.atMs)).toEqual([...CHEST_WAVE_MS]);
    expect(events.filter((e) => e.type === 'shake')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'part').map((e) => e.type === 'part' && e.index)).toEqual([0, 1, 2]);
    expect(Math.max(...events.map((e) => e.atMs))).toBeLessThan(CHEST_SHAKE_MS);
  });

  it('does not shake with Reduce Motion, but still knocks and glows', () => {
    const events = buildChestShakeTimeline({ reduceMotion: true });
    expect(events.some((e) => e.type === 'shake')).toBe(false);
    expect(events.filter((e) => e.type === 'haptic')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'part')).toHaveLength(3);
  });

  it('opens with a pop, a success haptic, then the reward; confetti only for a rare find and never with Reduce Motion', () => {
    const plain = buildChestOpenTimeline({ reduceMotion: false, confetti: false });
    expect(plain.map((e) => e.type)).toEqual(['sound', 'haptic', 'flash', 'reward']);
    const rare = buildChestOpenTimeline({ reduceMotion: false, confetti: true });
    expect(rare.find((e) => e.type === 'confetti')).toMatchObject({ pieces: 40 });
    const calm = buildChestOpenTimeline({ reduceMotion: true, confetti: true });
    expect(calm.some((e) => e.type === 'flash')).toBe(false);
    expect(calm.find((e) => e.type === 'confetti')).toMatchObject({ pieces: 0 });
  });

  it('colours the reward by rarity', () => {
    expect(rewardRarity({ kind: 'points', amount: 5, avatarKey: null }, AVATARS)).toBe('common');
    expect(rewardRarity({ kind: 'points', amount: 15, avatarKey: null }, AVATARS)).toBe('rare');
    expect(rewardRarity({ kind: 'points', amount: 25, avatarKey: null }, AVATARS)).toBe('epic');
    expect(rewardRarity({ kind: 'freeze', amount: 1, avatarKey: null }, AVATARS)).toBe('rare');
    expect(rewardRarity({ kind: 'avatar', amount: null, avatarKey: 'regenboog' }, AVATARS)).toBe('legendary');
    expect([isRareFind('rare'), isRareFind('epic'), isRareFind('legendary')]).toEqual([false, true, true]);
  });

  it('reads the answer of open_daily_chest and says it for VoiceOver', () => {
    const opened = parseChestOpened({
      day: '2026-10-20',
      reward: { key: 'points_15', kind: 'points', amount: 15, avatar_key: null, status: 'pending' },
      already_opened: false,
      as_of: 'x',
    });
    expect(opened).toEqual({
      day: '2026-10-20',
      reward: { key: 'points_15', kind: 'points', amount: 15, avatarKey: null, status: 'pending' },
      alreadyOpened: false,
    });
    expect(parseChestOpened({ day: '2026-10-20', reward: { kind: 'points' } })).toBeNull();
    expect(chestSummary(opened!.reward, '+15')).toBe('Je kist: 15 punten, wacht op goedkeuring.');
  });

  it('hands the preview and the presenter callback to the screen once', () => {
    const reward = { key: 'freeze', kind: 'freeze' as const, amount: 1, avatarKey: null, status: 'pending' as const };
    setPendingChestPreview({ reward });
    expect(takePendingChestPreview()?.reward).toEqual(reward);
    expect(takePendingChestPreview()).toBeNull();
    const done = () => {};
    setChestOnClose(done);
    expect(takeChestOnClose()).toBe(done);
    expect(takeChestOnClose()).toBeNull();
  });
});

const QUEST = { id: 'q1', period: 'day', slot: 'easy', template_key: 'checkin_any', title: 'Doe een inworp', progress: 1, target: 1, reward: 5, freezes: 0 };

describe('quest moments after the reveal', () => {
  it('shows the quests this check-in completed and the chest it made ready', () => {
    const game = parseCheckinGame({
      milestone: null,
      badges: [],
      quests: [
        { ...QUEST, status: 'pending', completed_now: true },
        { ...QUEST, id: 'q2', slot: 'medium', status: 'open', progress: 1, target: 2, completed_now: false },
        { ...QUEST, id: 'q3', slot: 'hard', status: 'pending', completed_now: false },
      ],
      chest: { id: 4, day: '2026-10-20', status: 'ready', quests_done: 3, quests_total: 3, ready_now: true },
      freezes: [{ source: 'quest', status: 'pending' }, { source: 'chest', status: 'pending' }],
      as_of: '2026-10-20T10:00:00+00:00',
    });
    const news = revealNews(game);
    expect(news.quests.map((q) => [q.id, q.templateKey, q.status])).toEqual([['q1', 'checkin_any', 'pending']]);
    expect(news.chestDay).toBe('2026-10-20');
    expect(news.freezes).toBe(1);
    expect(hasRevealNews(news)).toBe(true);
  });

  it('adds what the bonus answer completed after the check-in', () => {
    const game = parseCheckinGame({ milestone: null, badges: [], quests: [], chest: null, freezes: [], as_of: 'x' });
    const later = parseUnseen({
      as_of: 'y',
      moments: [
        { kind: 'quest', at: 'y', ...QUEST, slot: 'easy', template_key: 'bonus_answer', title: 'Beantwoord een bonusvraag', status: 'pending' },
        { kind: 'chest', at: 'y', day: '2026-10-20' },
      ],
    })!.moments;
    const news = revealNews(game, later);
    expect(news.quests.map((q) => q.templateKey)).toEqual(['bonus_answer']);
    expect(news.chestDay).toBe('2026-10-20');
    expect(hasRevealNews(revealNews(game))).toBe(false);
  });

  it('dings for quests without a milestone or discoveries', () => {
    const events = buildCelebrationTimeline({ milestone: false, discoveries: false, quests: true, reduceMotion: false });
    expect(events[0]).toMatchObject({ type: 'sound', id: 'quest_ding' });
    expect(buildCelebrationTimeline({ milestone: true, discoveries: false, quests: true, reduceMotion: false })[0]).toMatchObject({
      id: 'milestone_fanfare',
    });
  });

  it('summarises missed quests, the newest ready chest and the freezes', () => {
    const unseen = parseUnseen({
      as_of: 'z',
      moments: [
        { kind: 'quest', at: 'a', ...QUEST, status: 'pending' },
        { kind: 'quest', at: 'b', ...QUEST, status: 'granted' },
        { kind: 'chest', at: 'a', day: '2026-10-19' },
        { kind: 'chest', at: 'b', day: '2026-10-20' },
        { kind: 'freeze', at: 'b', source: 'milestone', status: 'pending' },
        { kind: 'freeze', at: 'b', source: 'nope', status: 'pending' },
      ],
    })!;
    const summary = summarizeMoments(unseen.moments);
    expect(summary.quests.map((q) => q.status)).toEqual(['granted']);
    expect(summary.chestDay).toBe('2026-10-20');
    expect(summary.freezes).toBe(1);
  });
});
