# Architectural Precedents

Titles index for the architectural precedents that Open Knowledge code cites as `precedent #N`. Numbers are a stability contract: a slot is never renumbered and never reused, so a citation resolves to the same rule for as long as the code carries it. A rule that was withdrawn keeps its slot and is marked below.

60 numbered slots, 57 active, 3 retracted.

## Convention & discipline (precedents 1–8)

1. **Typed transaction origins.**
2. **Generic primitives over specific ones.**
3. **Structured event schemas.**
4. **Shared computation, per-surface rendering.**
5. **Contract-first MCP tools.**
6. **Mode state as enums.**
7. **Remove broken capabilities rather than shipping them.**
8. **Separate long-lived identity from short-lived session concerns.**

## CRDT bridge & schema (precedents 9–14, 28, 38)

9. **Schema is add-only forever.**
10. **Opaque-but-content-bearing nodes for Y.Item identity.**
11. **Minimize CRDT mutation in sync bridges.**
12. **[RETRACTED — superseded by precedent #38 (Y.Text-is-truth contract).]**
13. **Bridge invariants are auto-enforced and property-verified.**
14. **Cross-CRDT sync is single-writer, server-side.**
28. **Direct PM dispatch for nested editors.**
38. **Y.Text-is-truth contract: Y.Text holds user-intended source-form bytes; XmlFragment derives via `parse(ytext)`.**

## Markdown pipeline (precedents 15–17)

15. **Idempotent micromark-extension attachers.**
16. **Phase-ordered visitor dispatchers when passes consume each other's output.**
17. **Byte-for-byte equivalence validators gate high-risk refactors.**

## UI / React patterns (precedents 18, 19, 21, 29, 30)

18. **Hybrid Activity + Suspense + `use(promise)` for subscription-source async primitives.**
19. **Clipboard pipeline is mdast-canonical with per-view hook mechanisms.**
21. **Ancestor-priority for auto-revealing tree-state derivations.**
29. **Compound components use DOM data-attributes to bridge across NodeView portal boundaries.** RETRACTED.
30. **All user content visible and editable (no hidden content).**

## Testing, tooling, infra (precedents 20, 22, 23)

20. **E2E test infrastructure conventions.**
22. **Shell-script conventions for repo tooling.**
23. **Async socket errors on closing sockets are caught at the boundary, not pre-filtered in userspace.**

## Actor identity & attribution (precedents 24, 25)

24. **Per-session actor identity at the CRDT origin layer.**
25. **Classified writer IDs + subject-prefix action encoding in the shadow repo.**

## Perf + V2 editor architecture (precedents 26–27)

26. **Perf instrumentation as first-class.**
27. **V2 editor cache + InteractionLayer + Option E split walker (2026-04-20) + cv-auto block-chunked render (2026-04-30).**

## Selection & chrome architecture (precedents 31–37)

31. **Selection state as typed PM PluginState.**
32. **`data-*` attributes over className toggling for composable states in React-rendered NodeViews.**
33. **CSS custom-property tokens scoped via `[data-component-type]` for per-block-type theming.**
34. **Innermost-wins visible chrome, ancestor propagation via state (not `:has()`).**
35. **Floating UI is the canonical positioning primitive for selection-anchored overlays.**
36. **A11y codified in the selection plugin, not retrofitted per-block.**
37. **Asset-click dispatch is a single shared surface.**

## API surface discipline (precedent 39)

39. **HTTP `/api` routes emit RFC 9457 problem details on errors and a flat success body keyed by HTTP status.**

## Cross-process state mirroring (precedent 40)

40. **Renderer-state↔main-state propagation: typed-IPC push + show-gate dual-signal + build-time token resolution for cross-process value sharing.**

## Connection-admission stacking (precedent 41)

41. **Connection-admission policies stack via `hocuspocus.configuration.extensions.push()` after identity threading; admission decisions that depend on a recently-removed cache consult the cache FIRST and use the on-disk file as a disambiguator only when the cache has an entry.**

## Custom lint enforcement (precedent 42)

42. **Custom lint enforcement is oxlint JS-plugin rules.**

## Tier-3 React-runtime test substrate (precedent 43)

43. **Tier-3 React-runtime tests (RTL mount under jsdom 29) run in a dedicated Vitest project (`packages/app/vitest.dom.config.ts`) with per-project `setupFiles` — never a global preload.**

## Editor DOM-tree exclusivity + delete-then-recreate coordination (precedent 44)

44. **TipTap `view.dom` DOM-tree exclusivity is a load-bearing OK invariant — `<EditorContent>` MUST render via `React.createPortal` to a per-Activity exclusively-owned DOM target; parked-state cache entries MUST own per-entry parking nodes; client `closeAndClearPersistence` and concurrent `pool.open` MUST coordinate via `pendingClears`; server-side `shouldUnloadDocument` MUST honor `forceUnload` unconditionally.**

## JSX selection UX corrections (precedents 45–48)

45. **`--selection-halo-inset` is uniform across substrates; per-substrate inset overrides are precluded.**
46. **Customer-facing JSX descriptors with required string props key off key-absence, not empty-string, to surface the missing-decision state.**
47. **Test-file substrate vocabulary is structurally checked against the registry via a meta-test.**
48. **Block-level keyboard contract is structural, not mode-based; `KeyboardNav` is the canonical home.**

## Electron host chrome safe area (precedent 49)

49. **In-window full-viewport overlays must reserve the macOS traffic-light footprint via `--ok-titlebar-reserve-left`.**

## Project locality for LLM-functional resources (precedents 50, 51)

50. **Project locality for LLM-functional + reproducibility-sensitive resources.**
51. **Every overlay primitive carries a one-line `motion-reduce:` opt-in inline on its Content (and SubContent where present) — the only OK divergence from shadcn `radix-nova` upstream motion across the 7 overlay primitives (Dialog, Sheet, Popover, Select, Dropdown-menu, Context-menu, Tooltip).**

## ~~Two-tier overlay-motion system — documented forks of the radix-nova preset~~ (precedent 52 — RETRACTED)

52. **The 7 overlay primitives in the design system are organized into a two-tier motion system: a snappy tier (100ms transition-based enter / 0ms exit) for the 5 high-frequency primitives (Popover, Select, Dropdown-menu, Context-menu, Tooltip) — implemented as documented forks of the radix-nova shadcn preset's animation utilities — and a standard tier (200ms enter / 150ms exit) for the 2 low-frequency primitives (Dialog, Sheet), with Dialog additionally exposing a typed two-tier `transition?: 'standard' | 'snappy'` prop on DialogOverlay + DialogContent so the palette can opt into the snappy tier without forking the modal class set.** RETRACTED.

## Category-aware overlay placement — generic dialogs center, command/search palettes top-anchor (precedent 53)

**Overlay placement is category-aware, expressed via an inline className on the palette-category primitive (`CommandDialog`) — mirroring shadcn `radix-nova` upstream's own pattern.**

## Structural lifecycle gates on mutating write spines (precedent 54)

54. **Lifecycle-state refusal on mutating write spines is structural, expressed via a single typed-throw class + a single HTTP-response helper + a meta-test that scans every mutating route.**

## Content scope predicate symmetry (precedent 55)

55. **`ContentFilter` is the single source of truth for whether a path is in OK content scope; walkers may not augment it with local admission rules.**

## Canonical link contract (precedent 56)

56. **OK has two valid internal-link forms — relative (`./sibling.md`, `../folder/doc.md`) and root-absolute (`/folder/doc.md`, leading slash = content root) — and the substrate VALIDATES every outbound link at write time so a broken hybrid never ships silently.**

## Per-write-path fidelity bar (precedent 57)

57. **Every write surface declares its fidelity bar at the intake layer — byte-sacred or construct-canonical — never inside the serializer.**

## One-transaction menu insertions (precedent 58)

58. **A menu that deletes its trigger range and then inserts content MUST land both in one transaction; the menu item contributes steps, never a dispatch of its own.**

## Project scoping for renderer storage names (precedent 59)

59. **Every client-side persistent storage name whose collision domain is the ORIGIN must be scoped to the project through `scopedStorageKey` (`packages/app/src/lib/storage-scope.ts`), or explicitly justify itself as app-global.**

## Native-handoff transport carries path and prompt only (precedent 60)

60. **A native-handoff deep link carries a folder or workspace path plus a short directive prompt — never a `file=` attach param and never whole-doc bytes; the receiving agent grounds by reading the doc through the OpenKnowledge MCP server.**
