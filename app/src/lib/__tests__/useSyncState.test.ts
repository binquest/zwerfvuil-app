import { describe, expect, it } from '@jest/globals';

import { createStore } from '../useSyncState';

describe('createStore', () => {
  it('holds a value and notifies subscribers on a change', () => {
    const store = createStore(0);
    const seen: number[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.get()));
    store.set(3);
    store.set((previous) => previous + 1);
    expect(store.get()).toBe(4);
    expect(seen).toEqual([3, 4]);
    unsubscribe();
    store.set(9);
    expect(seen).toEqual([3, 4]);
  });

  it('does not notify when the value stays the same', () => {
    const store = createStore('playing');
    let calls = 0;
    store.subscribe(() => calls++);
    store.set('playing');
    expect(calls).toBe(0);
  });
});
