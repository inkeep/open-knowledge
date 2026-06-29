import type { Partition, SidebarSide, SidebarState } from './sidebar-partition.ts';
import { smartDefault } from './sidebar-partition.ts';

export const SIDEBAR_PINS_KEY = 'ok-sidebar-pins-v2';

type PartitionSlots = Partial<Record<Partition, SidebarState>>;

export interface StoredPins {
  left?: PartitionSlots;
  right?: PartitionSlots;
}

export interface PinStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isSidebarState(v: unknown): v is SidebarState {
  return v === 'open' || v === 'collapsed';
}

function isPartitionKey(v: string): v is Partition {
  return v === 'above' || v === 'below' || v === 'embedded';
}

function isValidSlots(v: unknown): v is PartitionSlots {
  if (typeof v !== 'object' || v == null) return false;
  const obj = v as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!isPartitionKey(key)) return false;
    if (!isSidebarState(obj[key])) return false;
  }
  return true;
}

function parseStoredPins(raw: string): StoredPins {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed == null) return {};
  const obj = parsed as Record<string, unknown>;
  const result: StoredPins = {};
  if (isValidSlots(obj.left)) result.left = obj.left;
  if (isValidSlots(obj.right)) result.right = obj.right;
  return result;
}

export function readPins(storage?: PinStorage): StoredPins {
  try {
    const s = storage ?? localStorage;
    const raw = s.getItem(SIDEBAR_PINS_KEY);
    if (raw == null) return {};
    return parseStoredPins(raw);
  } catch {
    return {};
  }
}

function writePins(pins: StoredPins, storage: PinStorage): void {
  try {
    storage.setItem(SIDEBAR_PINS_KEY, JSON.stringify(pins));
  } catch {
  }
}

export function resolveEffectiveState(
  side: SidebarSide,
  currentPartition: Partition,
  pins: StoredPins,
): SidebarState {
  return pins[side]?.[currentPartition] ?? smartDefault(currentPartition);
}

export function applyToggle(
  side: SidebarSide,
  currentPartition: Partition,
  newState: SidebarState,
  storage?: PinStorage,
): StoredPins {
  const s = storage ?? localStorage;
  const pins = readPins(s);
  pins[side] = { ...pins[side], [currentPartition]: newState };
  writePins(pins, s);
  return pins;
}
