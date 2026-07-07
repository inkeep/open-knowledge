/**
 * Fixed-capacity O(1)-push ring buffer.
 *
 * Replaces `array.push` (unbounded growth) and `array.shift` (O(n) memmove
 * in V8) for the `__ok_perf` collector ring-store. Long-running DEV
 * sessions accumulate ~77 mark namespaces × hundreds of emissions/min;
 * a ring is the architecturally correct primitive.
 *
 * Storage: pre-allocated `Array<T | undefined>` of size `capacity`.
 * Writes go to `slots[head]`; head increments modulo capacity. When the
 * buffer is full subsequent pushes overwrite the oldest entry.
 *
 * `toArray()` returns items in chronological order (oldest first when
 * full; insertion order from index 0 when partial). Callers that need an
 * ordered snapshot for serialization / map / filter call this; readers
 * tolerant of internal layout call `forEach`.
 */
export class CircularBuffer<T> {
  private readonly capacity: number;
  private readonly slots: Array<T | undefined>;
  private head = 0;
  private size = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`CircularBuffer capacity must be a positive integer (got ${capacity})`);
    }
    this.capacity = capacity;
    this.slots = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    this.slots[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  /**
   * Snapshot of items in chronological order:
   * - When `size < capacity`: items at indices [0, size).
   * - When full: items wrap from `head` (oldest) around to `head - 1` (newest).
   */
  toArray(): T[] {
    const out: T[] = new Array<T>(this.size);
    if (this.size < this.capacity) {
      for (let i = 0; i < this.size; i += 1) {
        out[i] = this.slots[i] as T;
      }
    } else {
      // Full: oldest slot is at `head` (next overwrite target). Walk from
      // head around the ring.
      for (let i = 0; i < this.capacity; i += 1) {
        out[i] = this.slots[(this.head + i) % this.capacity] as T;
      }
    }
    return out;
  }

  get length(): number {
    return this.size;
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i += 1) this.slots[i] = undefined;
    this.head = 0;
    this.size = 0;
  }
}
