// useState whose updates render in the same JS task as the call.
//
// A plain setState from a timer is rendered later, in a normal-priority task.
// React Native runs timers and native callbacks first (immediate priority), so
// during a busy stretch such as the points reveal, the screen can lag seconds
// behind the sounds that the same timer already started. An update through
// useSyncExternalStore is rendered synchronously (React's sync lane) at the end
// of the current task instead.
import { useState, useSyncExternalStore } from 'react';

export interface Store<T> {
  get(): T;
  set(next: T | ((previous: T) => T)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === 'function' ? (next as (previous: T) => T)(value) : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Like useState (with a stable setter), but every update renders in the same task. */
export function useSyncState<T>(initial: T): [T, Store<T>['set']] {
  const [store] = useState(() => createStore(initial));
  const value = useSyncExternalStore(store.subscribe, store.get);
  return [value, store.set];
}
