export interface BoundedPark<K, V extends object> {
  park(key: K, value: V): void;
  reclaim(key: K): V | undefined;
  clear(): void;
}

export function createBoundedPark<K, V extends object>({
  capacity,
  dispose,
}: {
  capacity: number;
  dispose: (value: V) => void;
}): BoundedPark<K, V> {
  const parked = new Map<K, V>();
  return {
    park(key, value) {
      const replaced = parked.get(key);
      parked.delete(key);
      parked.set(key, value);
      if (replaced !== undefined && replaced !== value) dispose(replaced);
      for (const [oldestKey, oldest] of parked) {
        if (parked.size <= capacity) return;
        parked.delete(oldestKey);
        dispose(oldest);
      }
    },
    reclaim(key) {
      const value = parked.get(key);
      parked.delete(key);
      return value;
    },
    clear() {
      const values = [...parked.values()];
      parked.clear();
      for (const value of values) dispose(value);
    },
  };
}
