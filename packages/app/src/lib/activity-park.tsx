import {
  Activity,
  createContext,
  type ReactNode,
  use,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react';
import { type BoundedPark, createBoundedPark } from './bounded-park';

interface ParkScope {
  onSweep(sweep: () => void): void;
  parked(): void;
}

interface ParkScopeOwner extends ParkScope {
  setHidden(hidden: boolean): void;
  sweep(): void;
  attach(): void;
  detach(): void;
}

const ParkScopeContext = createContext<ParkScope | null>(null);

function createParkScope(): ParkScopeOwner {
  const sweeps: Array<() => void> = [];
  let hidden = false;
  let attached = false;
  let sweepQueued = false;
  const sweep = () => {
    for (const run of sweeps) run();
  };
  return {
    setHidden(next) {
      hidden = next;
    },
    sweep,
    attach() {
      attached = true;
    },
    detach() {
      attached = false;
      queueMicrotask(() => {
        if (!attached) sweep();
      });
    },
    onSweep(run) {
      sweeps.push(run);
    },
    parked() {
      if (hidden || sweepQueued) return;
      sweepQueued = true;
      queueMicrotask(() => {
        sweepQueued = false;
        if (!hidden) sweep();
      });
    },
  };
}

export function ParkingActivity({
  visible,
  name,
  children,
}: {
  visible: boolean;
  name?: string;
  children: ReactNode;
}) {
  const [scope] = useState(createParkScope);
  useLayoutEffect(() => {
    scope.setHidden(!visible);
  }, [scope, visible]);
  useEffect(() => {
    if (visible) scope.sweep();
  }, [scope, visible]);
  useEffect(() => {
    scope.attach();
    return () => scope.detach();
  }, [scope]);
  return (
    <ParkScopeContext value={scope}>
      <Activity mode={visible ? 'visible' : 'hidden'} name={name}>
        {children}
      </Activity>
    </ParkScopeContext>
  );
}

export interface ActivityPark<K, V extends object> {
  park(key: K, value: V): void;
  reclaim(key: K): V | undefined;
}

const parkInScope = Symbol('parkInScope');

export interface ActivityParks<K, V extends object> {
  readonly [parkInScope]: (scope: ParkScope) => ActivityPark<K, V>;
}

export function createActivityParks<K, V extends object>(options: {
  capacity: number;
  dispose: (value: V) => void;
}): ActivityParks<K, V> {
  const byScope = new WeakMap<ParkScope, ActivityPark<K, V>>();
  return {
    [parkInScope](scope) {
      const known = byScope.get(scope);
      if (known) return known;
      let parked: BoundedPark<K, V> | null = null;
      const park: ActivityPark<K, V> = {
        park(key, value) {
          if (!parked) {
            const created = createBoundedPark<K, V>(options);
            scope.onSweep(created.clear);
            parked = created;
          }
          parked.park(key, value);
          scope.parked();
        },
        reclaim(key) {
          return parked?.reclaim(key);
        },
      };
      byScope.set(scope, park);
      return park;
    },
  };
}

export function useActivityPark<K, V extends object>(
  parks: ActivityParks<K, V>,
): ActivityPark<K, V> | null {
  const scope = use(ParkScopeContext);
  return scope ? parks[parkInScope](scope) : null;
}
