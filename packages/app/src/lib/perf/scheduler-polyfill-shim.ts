// Side-effect import: GoogleChromeLabs `scheduler-polyfill` installs
// `self.scheduler.yield()` on browsers that lack native support. The polyfill
// is an IIFE that runs once on load:
//
//   - If `self.scheduler` is undefined (Safari, older Firefox), it installs
//     the full Scheduler (yield + postTask) plus TaskController and
//     TaskPriorityChangeEvent. Yield falls through MessageChannel →
//     requestIdleCallback → setTimeout depending on which primitive is
//     available.
//   - If `self.scheduler` exists but `yield` is missing (Chromium versions
//     between Scheduler and yield landing), it installs `yield()` as a
//     `postTask({priority: 'user-blocking'})` shim.
//   - On modern Chromium / Electron with full native support, the polyfill is
//     a no-op (the conditional install branches are skipped).
//
// The polyfill must run before any code that calls `scheduler.yield()`. The
// app entrypoint (main.tsx) imports this shim at module-load time so the
// install IIFE fires before any editor module loads.
//
// Loading discipline: this is an *eager* import, not a lazy chunk. The
// polyfill is small (~2 KB gzipped) and its primary callers (mount-promise.ts
// at construction-mount yield-point) need it synchronously available on first
// cold-mount — a lazy chunk would push the first-cold-mount yield onto the
// network/parse path, defeating the primary purpose of yielding.
//
// The bundled `.d.ts` augments the global `Scheduler` interface with
// `yield()` and `postTask()` AND declares the global `const scheduler:
// Scheduler` so call sites can write `await scheduler.yield()` directly. The
// only path to pull in those globals is to import the polyfill (or this shim)
// somewhere in the compilation closure — main.tsx does that.

import 'scheduler-polyfill';
