# The `ok` oxlint rules

Custom lint rules for this workspace. Each rule is a module under `rules/`, composed into the single `ok` plugin by [`index.mjs`](index.mjs) and switched on in [`oxlint.config.ts`](../../oxlint.config.ts) as `ok/<rule-name>`. A rule that only applies to a subset of files carries its globs in [`scope.mjs`](scope.mjs) rather than in config — see [Scope it, if it is not workspace-wide](#3-scope-it-if-it-is-not-workspace-wide) below.

Rules surface as lint errors during `pnpm run lint:oxlint` (i.e. `pnpm lint` and `pnpm check`) and as inline editor squiggles via the oxc LSP.

One plugin holding every rule is deliberate: oxlint walks the AST once and dispatches every registered visitor, so rules amortize. Measured on this tree, 12 synthetic probe rules added 0.17s and all 23 real rules cost nothing detectable against a no-rule baseline. The GritQL plugins these replaced cost about 3.3s each because every plugin re-traversed.

## Convention

**All custom lint enforcement uses oxlint JS-plugin rules** — [PRECEDENTS.md #42](../../PRECEDENTS.md#custom-lint-enforcement-precedent-42). Add a module under `rules/` + a fixture-file test. The fixture-file test is non-negotiable: it preserves the mutation-self-test property by asserting an exact diagnostic count on a fixture pairing positive cases with negative cases.

**Rule modules carry no prose comments.** These are `.mjs` files, so the [no-comments policy](../no-comments/README.md) applies to them — unlike the `.grit` files they replaced, which sat outside it and carried long rationale headers. That rationale lives here instead, in the rule's section below. When you write a rule, budget for writing its README section in the same change; there is nowhere else for the reasoning to go.

**Diagnostic messages name the fix and link the docs.** Every message has two load-bearing pieces: (a) a noun-phrase or action verb-phrase that names what to do to fix the violation (the fix-noun — readers see this and know the next move without leaving the editor); (b) a trailing `See <docs-URL>` pointing at the rule's section in this README so the message stays self-documenting. Process metadata (decision markers like `D19:`, spec-section refs) does NOT belong in the diagnostic — it rots the same way it rots in source comments. The fixture test asserts both pieces are present (substring match for the fix-noun + URL regex) so the convention survives drift.

## Rules

A scoped rule's section carries an `Included:` line transcribed by hand from its scope entry in `scope.mjs`. Nothing generates or drift-checks the two, so `scope.mjs` is what the linter reads and the line is a copy that can fall behind it. Most scoped sections restate those globs again in their surrounding prose, which is a second copy on top of the first. `require-utf8-multipart-parser` is the one written the other way round on purpose: its prose argues the rationale and leaves the globs to that line alone. That is the intended shape for new sections; converting the remaining ones is deferred rather than forgotten.

### `microcopy-ellipsis`

Flags U+2026 (`…`) in two JSX surfaces:
- **JSX text children** — `<span>Loading…</span>`
- **JSX attribute string values** for `placeholder | label | title | aria-label | description | tooltip`

The codebase reserves `…` for two cases only:
1. **macOS native menu items** (rendered via `Menu.buildFromTemplate` in `packages/desktop/src/main/menu.ts`). Native-OS convention for "opens a new surface" (Apple/Windows/GTK HIG).
2. **Truncation indicators** — where `…` literally means "I cut text here" (graph labels, breadcrumb collapse, search snippets, sha256 prefixes, token-prefix elisions).

The rule does NOT catch:
- Object-literal menu templates (`{ label: 'Settings…' }`) — naturally skipped because they're not JSX, which is correct (Electron menus belong to case #1).
- `…` in plain `.ts` files — naturally skipped because they're not JSX (graph-label-utils, suggest-links, etc. — these are all case #2 truncation utilities).
- `…` in CLI strings (`process.stderr.write('Cloning…')`) — uncaught gap; review discipline covers the small CLI surface.
- `…` in JSX expression-child string literals (`<span>{'Loading…'}</span>`) — uncaught gap; zero occurrences in the codebase today (developers write `<span>Loading…</span>` directly). If a realistic case emerges, add a `jsx_expression` pattern matching `string` literal children rather than retrofit ad-hoc.

Rule: [`lint-plugins/ok-rules/rules/microcopy-ellipsis.mjs`](rules/microcopy-ellipsis.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/microcopy-ellipsis.fixture.tsx`](__fixtures__/microcopy-ellipsis.fixture.tsx). Test: [`packages/app/tests/integration/microcopy-ellipsis.test.ts`](../../packages/app/tests/integration/microcopy-ellipsis.test.ts).

### `no-loosely-typed-webcontents-ipc`

IPC discipline enforcement. Forbids direct electron IPC primitives (`webContents.send`, `ipcMain.handle/on`, `ipcRenderer.invoke/on/once`) outside the typed-wrapper files. Consumers must route through `createInvoker` / `createHandler` / `sendToRenderer` from `packages/desktop/src/shared/ipc-*.ts`. See [PRECEDENTS.md #14](../../PRECEDENTS.md) for the IPC discipline rationale.

Rule: [`lint-plugins/ok-rules/rules/no-loosely-typed-webcontents-ipc.mjs`](rules/no-loosely-typed-webcontents-ipc.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/no-loosely-typed-webcontents-ipc.fixture.tsx`](__fixtures__/no-loosely-typed-webcontents-ipc.fixture.tsx). Test: [`packages/desktop/tests/integration/no-loosely-typed-webcontents-ipc.test.ts`](../../packages/desktop/tests/integration/no-loosely-typed-webcontents-ipc.test.ts).

### `no-raw-html-interactive-element`

UI primitives discipline. Forbids raw JSX `<button>`, `<input>`, `<textarea>`, `<select>` inside production `.tsx` under `packages/{app,desktop,plugin}/src/**`. Consumers must use the shadcn primitives (`Button`, `Input`, `Textarea`, `Select`) from `@/components/ui/*`; if the primitive isn't installed yet, add it via `pnpm dlx shadcn@latest add <name>` first. The rule catches the PR #937 failure mode: contributors (including Codex / Claude Code / human reviewers) introducing raw `<button>` JSX while a shadcn `<Button>` from `@/components/ui/button` was already imported in the same file.

**Scoped** (see the rule's `RULE_SCOPES` entry in [`scope.mjs`](scope.mjs)) to `packages/{app,desktop,plugin}/src/**/*.tsx`. Exemptions are the leading-`!` globs in that same entry:

- `!packages/app/src/editor/**` — ProseMirror NodeViews + editor chrome legitimately render raw HTML for measurement / PM-managed DOM. The exemption matches the existing `a11y/useSemanticElements` suppressions scattered through the editor subtree.
- `!packages/app/src/components/ui/**` — these files ARE the shadcn primitive wrappers; they MUST render raw HTML by definition.
- `!**/*.test.tsx` + `!**/*.dom.test.tsx` + `!**/*.test-helper.tsx` — test fixtures and shared test doubles aren't user-facing UI.

**Pre-rule backlog (ratchet pattern).** Files that pre-date the rule and use raw `<button>` / `<input>` / `<textarea>` carry a file-level `// oxlint-disable ok/no-raw-html-interactive-element -- pre-rule backlog — ...` comment at the top of the file. The comment list across the codebase IS the visible migration backlog — review treats each `oxlint-disable` file header as a backlog marker, not a free pass. Drain by migrating the file to shadcn primitives, then deleting the suppression header (the rule starts firing again immediately, so a partial migration that misses a raw `<button>` fails the gate). Reference migration: `packages/app/src/components/NavigatorApp.tsx` (three raw `<button>` → shadcn `<Button variant="ghost|outline|link">`).

The rule does NOT catch:
- PascalCase composite components whose name starts with `Button` / `Input` (e.g. `<ButtonGroup>`, `<InputGroup>`) — pattern scopes to lowercase JSX tag names only.
- Raw HTML in `.ts` files (e.g. dangerouslySetInnerHTML strings, template literals).
- Raw `<a>` used as an action — anchor-as-button is governed by Biome's built-in `a11y/useSemanticElements` + the codebase's existing button-vs-anchor conventions.
- Other interactive primitives (`<dialog>`, `<details>`, `<summary>`) where the team hasn't yet committed to a shadcn-only contract.

**Scope** (`RULE_SCOPES['no-raw-html-interactive-element']` in [`scope.mjs`](scope.mjs)). UI primitives discipline (see PR #937 retrospective). Scoped to packages/{app,desktop,plugin}/src/**/*.tsx — production UI surfaces. Exemptions: - packages/app/src/editor/** — ProseMirror NodeViews + chrome legitimately render raw HTML for measurement / PM-managed DOM (matches the existing a11y/useSemanticElements suppressions in editor/*). - packages/app/src/components/ui/** — these ARE the shadcn primitive wrappers; they must render raw HTML by definition. - *.test.tsx / *.dom.test.tsx / *.test-helper.tsx — test fixtures and shared test doubles aren't user-facing UI. Pre-rule backlog (files outside the exemptions that pre-date the rule) is annotated via `// oxlint-disable ok/no-raw-html-interactive-element --` at the top of each offender file — the comment list is the visible migration backlog. New files cannot opt out: PR review treats the suppression header as a backlog marker, not a free pass.

Included: `packages/app/src/**/*.tsx`, `packages/desktop/src/**/*.tsx`, `packages/plugin/src/**/*.tsx`, `lint-plugins/ok-rules/__fixtures__/no-raw-html-interactive-element.fixture.tsx`. Excluded: `packages/app/src/editor/**`, `packages/app/src/components/ui/**`, `**/*.test.tsx`, `**/*.dom.test.tsx`, `**/*.test-helper.tsx`.

Rule: [`lint-plugins/ok-rules/rules/no-raw-html-interactive-element.mjs`](rules/no-raw-html-interactive-element.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/no-raw-html-interactive-element.fixture.tsx`](__fixtures__/no-raw-html-interactive-element.fixture.tsx). Test: [`packages/app/tests/lint-plugins/no-raw-html-interactive-element.test.ts`](../../packages/app/tests/lint-plugins/no-raw-html-interactive-element.test.ts). See [PRECEDENTS.md #42](../../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the custom-rule convention.

### `no-themeless-pierre-diff`

`@pierre/diffs` render contract. Every `<MultiFileDiff>` construction site under `packages/app/src/**/*.tsx` (both the self-closing and the child-bearing JSX form) must pass an explicit `theme` and must set `diffStyle: 'unified'`. `new UnresolvedFile(...)` is covered by the `theme` half only — the constructor surfaces take no `diffStyle`.

The `theme` check reads the `options` object, not the whole prop list, so a `theme` token elsewhere on the element (`data-theme="dark"`, a title string, a variable named `theme` passed to an unrelated prop) cannot suppress the diagnostic. The fixture pins that with a decoy case.

Both halves are load-bearing. Pierre ships its own palette, so a themeless renderer paints in Pierre's colours instead of the app's and stops tracking the user's light/dark selection. And `diffStyle: 'split'` renders the two sides as separate DOM subtrees, so the change-stepper's DOM-order adjacency grouping counts roughly 2x the real groups — the displayed denominator desyncs from the anchors the stepper can actually reach.

This rule replaces a `readFileSync` + regex meta-test that asserted the same invariant over source text. That test violated the AGENTS.md rule against asserting raw source text for props ("Source guards need proof runtime coverage is impossible" — it wasn't), and it carried a tautological self-test that ran a regex over its own string literals. The per-component half of its intent now lives in runtime assertions in `ActivityPanelDiffView.dom.test.tsx` (`pre[data-diff-type="single"]` for unified; the injected `:host` token block for theme). Lint is the right layer for the codebase-wide "no call site omits it" half — [PRECEDENTS.md #42](../../PRECEDENTS.md#custom-lint-enforcement-precedent-42).

The rule does NOT catch:
- a `@pierre/diffs` constructor other than `UnresolvedFile` — `new File(...)`, or any aliased import such as `File as PierreFile` in [`ConflictFilePreview.tsx`](../../packages/app/src/components/ConflictFilePreview.tsx). the rule matches the identifier as written, so a rename defeats it
- a renamed `MultiFileDiff` import, for the same reason
- a theme reaching the renderer through a spread or a variable (`options={{ ...baseOptions }}`, `options={opts}`) — the check reads the object literal, and there is no occurrence today

Runtime complement: `packages/app/src/components/ActivityPanelDiffView.dom.test.tsx` asserts the rendered result on the one surface this migration adds — `pre[data-diff-type="single"]` for unified, and the injected `:host` token block for theme.

**Scope** (`RULE_SCOPES['no-themeless-pierre-diff']` in [`scope.mjs`](scope.mjs)). @pierre/diffs render contract. Every construction site passes an explicit theme and renders unified. Scoped to production .tsx under packages/app/src; the fixture is opted in so its deliberate violations are what the rule's fixture test counts.

Included: `packages/app/src/**/*.tsx`, `lint-plugins/ok-rules/__fixtures__/no-themeless-pierre-diff.fixture.tsx`. Excluded: `**/*.test.tsx`, `**/*.dom.test.tsx`, `**/*.test-helper.tsx`.

Rule: [`lint-plugins/ok-rules/rules/no-themeless-pierre-diff.mjs`](rules/no-themeless-pierre-diff.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/no-themeless-pierre-diff.fixture.tsx`](__fixtures__/no-themeless-pierre-diff.fixture.tsx). Test: [`packages/app/tests/lint-plugins/no-themeless-pierre-diff.test.ts`](../../packages/app/tests/lint-plugins/no-themeless-pierre-diff.test.ts).

### `no-resolved-value-theme-source`

1-way theme contract. Forbids resolving the user-intent theme value at the `bridge.setThemeSource(...)` call site. The contract is 1-way: pass the unresolved CRDT value (`'system' | 'light' | 'dark'`) verbatim. `'system'` delegates appearance tracking to macOS via `nativeTheme`; resolving at the call site (via `matchMedia` or a `prefersDark ? 'dark' : 'light'` ternary) loses tracking. See [PRECEDENTS.md #40(a)](../../PRECEDENTS.md) for the renderer-state↔main-state contract.

Detection patterns (call expressions only — type-declarations are naturally excluded):
- `setThemeSource($arg)` where `$arg` contains `matchMedia` (any form)
- `setThemeSource($arg)` where `$arg` contains both `'light'` and `'dark'` string literals (likely a ternary, either order)
- Matches both bare-call and member-call shapes (`obj.setThemeSource(...)`)

Rule: [`lint-plugins/ok-rules/rules/no-resolved-value-theme-source.mjs`](rules/no-resolved-value-theme-source.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/no-resolved-value-theme-source.fixture.tsx`](__fixtures__/no-resolved-value-theme-source.fixture.tsx). Test: [`packages/desktop/tests/integration/no-resolved-value-theme-source.test.ts`](../../packages/desktop/tests/integration/no-resolved-value-theme-source.test.ts).

### `no-split-suggestion-dispatch`

One-transaction suggestion insertion ([PRECEDENTS.md #58](../../PRECEDENTS.md#one-transaction-menu-insertions-precedent-58)). Inside a `@tiptap/suggestion` `Suggestion({ ... })` config, a trigger-range delete dispatched on its own (separate from the content insert) opens a re-entrant-dispatch window: anything fired synchronously during the delete's own `updateState` (a plugin `appendTransaction`, a view/NodeView update, the y-prosemirror binding reacting to the delete) can remap the selection onto an adjacent `selectable: true` node, and the follow-up insert then silently REPLACES that node. The fix is one chain (`.deleteRange(range).insertContent(...).run()`) or an `applySlashCommandItem`-style boundary (`packages/app/src/editor/slash-command/apply-item.ts`) for items needing post-commit work.

Detection patterns (scoped to `Suggestion($config)` call sites, so delete-only surfaces outside suggestion configs — e.g. a mention chip's remove button — never fire):
- a chain whose `.run()` receiver is the `deleteRange(...)` call itself (`....deleteRange(range).run()` — a compliant atomic chain always continues past the delete before `.run()`)
- `$editor.commands.deleteRange($range)` — the `commands.*` form dispatches immediately, always a standalone delete transaction

**Unscoped** (workspace-wide, like `microcopy-ellipsis` — it carries no `RULE_SCOPES` entry and sits in `UNSCOPED_RULES`): the pattern self-scopes to `Suggestion(...)` calls, and a future suggestion surface in any package must be covered without a scope-table edit.

The rule does NOT catch:
- a split whose delete chain carries a non-content step after `deleteRange` and before `.run()` (e.g. `.deleteRange(r).focus().run()`) — the `.run()` receiver is then not the `deleteRange` call
- a second dispatch made inside a delegated item body (`item.command(editor)` running its own `editor.chain().run()`) — lint can't see through delegation
- raw `view.dispatch(tr.delete(...))` inside a Suggestion config — no occurrence today

Runtime complement: `packages/app/src/editor/extensions/suggestion-atomicity.dom.test.tsx` + `slash-command-atomicity.dom.test.tsx` drive every registered suggestion surface through a real Enter and assert exactly one doc-changing transaction — they catch the delegated-dispatch shapes the lint can't.

Rule: [`lint-plugins/ok-rules/rules/no-split-suggestion-dispatch.mjs`](rules/no-split-suggestion-dispatch.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/no-split-suggestion-dispatch.fixture.tsx`](__fixtures__/no-split-suggestion-dispatch.fixture.tsx). Test: [`packages/app/tests/lint-plugins/no-split-suggestion-dispatch.test.ts`](../../packages/app/tests/lint-plugins/no-split-suggestion-dispatch.test.ts).

### `no-unportaled-editor-content`

H6 cross-doc DOM bleed contract. `@tiptap/react`'s `PureEditorContent.componentDidMount` runs `element.append(...editor.view.dom.parentNode.childNodes)` — a sibling-vacuum primitive. When `view.dom` shares a parent with another editor's `view.dom` (e.g., V2 cache parked nodes, cross-Activity reconciliation transitions), the vacuum drags foreign content into the active wrapper. The structural fix is to render every `<EditorContent>` via `React.createPortal` into a per-Activity exclusively-owned DOM target, so `view.dom`'s parent only ever contains THIS editor's nodes.

The rule flags every JSX usage of `<EditorContent>` — both self-closing and child-bearing forms — and asks the author to suppress at the canonical portaled site (where the createPortal call lives) with `// oxlint-disable-next-line ok/no-unportaled-editor-content -- <reason>`. Adding a non-portaled `<EditorContent>` anywhere else in the codebase becomes a lint error, gated at editor-save / `pnpm lint` time.

Canonical sanctioned shape (TiptapEditor.tsx):

```tsx
createPortal(
  <EditorContent editor={editor} className="..." />,
  portalTarget,
);
```

Rule: [`lint-plugins/ok-rules/rules/no-unportaled-editor-content.mjs`](rules/no-unportaled-editor-content.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/no-unportaled-editor-content.fixture.tsx`](__fixtures__/no-unportaled-editor-content.fixture.tsx). Test: [`packages/app/tests/integration/no-unportaled-editor-content.test.ts`](../../packages/app/tests/integration/no-unportaled-editor-content.test.ts). See [PRECEDENTS.md #44](../../PRECEDENTS.md) for the H6 cross-doc DOM bleed contract and [PRECEDENTS.md #42](../../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the custom-rule convention.

### `no-uninstall-forbidden-import`

"Connects to nothing" first-hop feedback. The self-uninstall window's survey and completion screens render after `ok uninstall --yes` has stopped the local Hocuspocus server and removed `~/.ok`, so the uninstall entry must never reach the editor, the CRDT stack, the provider pool, or the server bootstrap — and must eager-load (no dynamic `import()`) so those screens paint from memory once teardown is under way.

Scoped (see the rule's `RULE_SCOPES` entry in [`scope.mjs`](scope.mjs)) to `packages/app/src/uninstall/**` (test files exempt — a dom test legitimately does `await import('./main')` to prove the entry paints). Two diagnostics:
- A static import (`import … from`, `import type … from`, `import * as … from`, or side-effect `import`) whose source is an editor / CRDT / provider-pool / Hocuspocus-server specifier (`@/editor/*`, `@inkeep/open-knowledge-server`, `@hocuspocus/*`, `yjs`, `y-protocols`, `y-prosemirror`, `y-codemirror.next`, `y-indexeddb`, `@tiptap/y-tiptap`, `@tiptap/extension-collaboration*`). `@inkeep/open-knowledge-core` (shared types + constants) is deliberately allowed.
- Any dynamic `import()`.

This rule is **shallow, first-hop feedback only**. The authoritative gate is the transitive-module-graph test at [`packages/desktop/tests/unit/uninstall-module-graph.test.ts`](../../packages/desktop/tests/unit/uninstall-module-graph.test.ts), which builds the entry alone and checks its whole loaded-module set — so it also catches a forbidden module reached indirectly through a shared `@/lib` / `@/components/ui` module, and re-export (`export … from`) edges a first-hop rule cannot express.

**Scope** (`RULE_SCOPES['no-uninstall-forbidden-import']` in [`scope.mjs`](scope.mjs)). "Connects to nothing" first-hop feedback. The self-uninstall window's survey/completion screens render after `ok uninstall --yes` stops the local Hocuspocus server and removes ~/.ok, so the uninstall entry must never import the editor / CRDT / provider-pool / Hocuspocus-server surface, and must eager-load (no dynamic import). This is SHALLOW first-hop feedback; the authoritative gate is the transitive-graph test at packages/desktop/tests/unit/uninstall-module-graph.test.ts, which also catches indirect and re-export pull-ins a first-hop rule can't express. @inkeep/open-knowledge-core (shared types + constants) is allowed. Test files are excluded: the invariant is about the SHIPPED entry graph, and a dom test legitimately does `await import('./main')` to prove the entry paints (a dynamic import the eager-load rule would otherwise flag).

Included: `packages/app/src/uninstall/**/*.ts`, `packages/app/src/uninstall/**/*.tsx`, `lint-plugins/ok-rules/__fixtures__/no-uninstall-forbidden-import.fixture.tsx`. Excluded: `packages/app/src/uninstall/**/*.test.ts`, `packages/app/src/uninstall/**/*.test.tsx`, `packages/app/src/uninstall/**/*.dom.test.tsx`.

Rule: [`lint-plugins/ok-rules/rules/no-uninstall-forbidden-import.mjs`](rules/no-uninstall-forbidden-import.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/no-uninstall-forbidden-import.fixture.tsx`](__fixtures__/no-uninstall-forbidden-import.fixture.tsx). Test: [`packages/desktop/tests/integration/no-uninstall-forbidden-import.test.ts`](../../packages/desktop/tests/integration/no-uninstall-forbidden-import.test.ts). See [PRECEDENTS.md #42](../../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the custom-rule convention.

### `path-conditional-map-driven-origin`

Observer A origin discipline. Inside `packages/server/src/server-observers.ts`, every `Y.Doc.transact()` call MUST pass the sanctioned origin `OBSERVER_SYNC_ORIGIN` as its second argument (`doc.transact(fn, OBSERVER_SYNC_ORIGIN)`). Bare `doc.transact(fn)` - or a wrong origin - routes the write to `openknowledge-service` and breaks per-session UndoManager attribution (the `trackedOrigins` Set-identity match skips the transaction).

**Scoped** (see the rule's `RULE_SCOPES` entry in [`scope.mjs`](scope.mjs)) to `packages/server/src/server-observers.ts`. Other server files routing through `session.dc.document.transact(fn, session.origin)` are out of scope - that contract is enforced by `paired-write-enforcement.test.ts`.

The rule checks the **argument position** (the second argument node), not whether the call subtree contains the identifier somewhere. It matches every `transact(...)` call, then excludes the two sanctioned shapes (`transact($_, OBSERVER_SYNC_ORIGIN)` and the 3-arg `transact($_, OBSERVER_SYNC_ORIGIN, $...)`). A callback body that mentions `OBSERVER_SYNC_ORIGIN` for an unrelated reason therefore neither clears a bare/wrong call nor trips a correct one - the prior `contains`-based shape was falsely cleared by such a mention.

The rule does NOT catch:
- Transact calls outside `server-observers.ts` (scoped to the one observer-dispatch file)
- An origin passed in a position other than the second argument (the contract is second-argument placement; no real call site does otherwise)

**Scope** (`RULE_SCOPES['path-conditional-map-driven-origin']` in [`scope.mjs`](scope.mjs)). Observer A origin discipline. Scoped to the one file that owns the observer-cross-CRDT transact spine. Inside this file every `doc.transact(fn, origin)` must pass `OBSERVER_SYNC_ORIGIN` as the second argument; bare `doc.transact(fn)` (or a wrong origin) routes the write to `openknowledge-service` and breaks per-session UndoManager attribution. Other server files routing through `session.dc.document.transact(fn, session.origin)` are out of scope - that contract is enforced by `paired-write-enforcement.test.ts`.

Included: `packages/server/src/server-observers.ts`, `lint-plugins/ok-rules/__fixtures__/path-conditional-map-driven-origin.fixture.tsx`.

Rule: [`lint-plugins/ok-rules/rules/path-conditional-map-driven-origin.mjs`](rules/path-conditional-map-driven-origin.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/path-conditional-map-driven-origin.fixture.tsx`](__fixtures__/path-conditional-map-driven-origin.fixture.tsx). Test: [`packages/server/src/path-conditional-map-driven-origin.test.ts`](../../packages/server/src/path-conditional-map-driven-origin.test.ts).

### `cst-pm-handler-todo-stub`

Codemod handler TODO-stub grep. Flags handler files under `packages/md-conformance/src/substrates/*/handlers/` that still contain the codemod's stub body (`throw new Error("TODO: implement <substrate>:<dir>/<key>")`), so a codemod stub that survives to lint time is caught.

This is a TODO-stub grep, NOT an exhaustiveness check. Whether a substrate covers every PM node type (the node-set traversal over `packages/core/schema-snapshot.json`) is a separate concern owned by a suite-self-consistency gate. The compile-time backstop for missing methods is the TypeScript handlers-table type check against `ICstEngine`.

**Scoped** (see the rule's `RULE_SCOPES` entry in [`scope.mjs`](scope.mjs)) to the per-substrate handlers/ subtrees (see the rule's `RULE_SCOPES` entry in `scope.mjs`). The codemod implementation, harness tests, and oracles are out of scope (they legitimately produce strings containing "TODO: implement" in their own contexts).

The rule does NOT catch:
- Missing handler FILES (file-presence is out of the rule's scope; TypeScript + codemod coverage handle this)
- Whether the handler set is complete per the PM schema (a separate node-set traversal, deferred to the suite-self-consistency gate)
- Error subclasses (only matches `new Error(...)`)
- Non-anchored "TODO" mentions (regex requires the message to start with `TODO: implement`)

**Scope** (`RULE_SCOPES['cst-pm-handler-todo-stub']` in [`scope.mjs`](scope.mjs)). Handler TODO-stub grep: scaffolded handlers are seeded with `throw new Error("TODO: implement …")`, and this rule flags any stub that survives to lint time so an unfinished handler can't pass review. It is NOT an exhaustiveness check — type checks are the compile-time backstop for missing methods. Scoped narrowly to the handlers/ subtrees so harness tests and oracles (which legitimately produce "TODO: implement" strings in their own contexts) are out of scope.

Included: `packages/md-conformance/src/substrates/*/handlers/**/*.ts`, `lint-plugins/ok-rules/__fixtures__/cst-pm-handler-todo-stub.fixture.tsx`.

Rule: [`lint-plugins/ok-rules/rules/cst-pm-handler-todo-stub.mjs`](rules/cst-pm-handler-todo-stub.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/cst-pm-handler-todo-stub.fixture.tsx`](__fixtures__/cst-pm-handler-todo-stub.fixture.tsx). Test: [`packages/md-conformance/src/lint-plugins/cst-pm-handler-todo-stub.test.ts`](../../packages/md-conformance/src/lint-plugins/cst-pm-handler-todo-stub.test.ts).

### `class-proof-registration-discipline`

Class-proof DSL contract enforcement. Two arms, short-circuiting — Pattern A wins when both apply, so a call missing options reports once, not twice:

- **Pattern A (missing args):** flags `defineClassProof(name, opts)` when `opts` doesn't contain both `predicate:` and `proof:` property assignments.
- **Pattern B (outside canonical dir):** flags any `defineClassProof(...)` call. The scope entry excludes `packages/md-conformance/src/class-proofs/proofs/**`, so this fires only on registrations outside the sanctioned location.

Inside the canonical proofs/ dir, neither pattern fires — TypeScript's `ClassProofOptions<M>` signature backstops the missing-args check, and any `defineClassProof` call there is in the sanctioned location.

**Scoped** (see the rule's `RULE_SCOPES` entry in [`scope.mjs`](scope.mjs)) to all `.ts`/`.tsx`/`.mts` files EXCEPT the canonical `class-proofs/proofs/**` dir and `*.test.ts`/`*.test.tsx`/`*.test.mts` (test files that exercise the DSL are exempt — `dsl.test.ts` legitimately calls `defineClassProof` outside the canonical dir).

The rule does NOT catch:
- Missing-args violations inside the canonical proofs/ dir (TypeScript catches those)
- Functions with similar names (`myDefineClassProofVariant`) — pattern matches the exact function name
- Type references to `defineClassProof` — pattern scopes to call expressions

**Scope** (`RULE_SCOPES['class-proof-registration-discipline']` in [`scope.mjs`](scope.mjs)). Class-proof DSL registration discipline: registrations MUST live in the canonical proofs/ dir (one manifest as the single source of truth) and EVERY registration MUST pass `predicate` + `proof` options. The scope entry EXCLUDES the canonical dir — inside it, the TypeScript signature is the missing-args backstop; outside it, any `defineClassProof(...)` call fires (= wrong location), and missing args fire an additional diagnostic.

Included: `**/*.ts`, `**/*.tsx`, `**/*.mts`, `lint-plugins/ok-rules/__fixtures__/class-proof-registration-discipline.fixture.tsx`. Excluded: `**/node_modules/**`, `**/dist/**`, `**/*.test.ts`, `**/*.test.tsx`, `**/*.test.mts`, `packages/md-conformance/src/class-proofs/proofs/**`.

Rule: [`lint-plugins/ok-rules/rules/class-proof-registration-discipline.mjs`](rules/class-proof-registration-discipline.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/class-proof-registration-discipline.fixture.tsx`](__fixtures__/class-proof-registration-discipline.fixture.tsx). Test: [`packages/md-conformance/src/lint-plugins/class-proof-registration-discipline.test.ts`](../../packages/md-conformance/src/lint-plugins/class-proof-registration-discipline.test.ts).

### `playwright-prefer-to-have-count`

Flags `expect(await locator.count())` — the one-shot count snapshot that never retries. Under CI CPU contention the DOM settles a few frames after the read, so the assertion flakes while the auto-retrying web-first form `await expect(locator).toHaveCount(n)` passes deterministically (the no-retry read was one of the hidden-flake shapes in the 2026-06 e2e CI audit). The pattern matches the probe sub-expression regardless of the matcher that follows (`.toBe`, `.toEqual`, `.toBeGreaterThanOrEqual`, ...). Upstream precedent: eslint-plugin-playwright `prefer-to-have-count`.

**Scoped** (see the rule's `RULE_SCOPES` entry in [`scope.mjs`](scope.mjs)) to `packages/app/tests/{stress,visual,a11y}/**/*.e2e.ts` (the same three dirs `tests/integration/e2e-stop-rules.test.ts` source-scans) + the fixture. Not workspace-wide: outside Playwright specs, `.count()` is usually not a `Locator` and the web-first rewrite does not apply.

The rule does NOT catch:
- `expect.soft(await locator.count())` — different callee node shape; zero occurrences today.
- A count read assigned to a variable and asserted later (`const n = await loc.count(); expect(n).toBe(2)`) — two statements; the rule cannot correlate them. Add an e2e-stop-rules source-scan rule if the split form ever recurs.
- oxlint JS-plugin diagnostics are diagnostic-only — the `toHaveCount` rewrite is named in the message but not auto-applied.

**Scope** (`RULE_SCOPES['playwright-prefer-to-have-count']` in [`scope.mjs`](scope.mjs)). One-shot `expect(await locator.count())` reads never retry and are the canonical hidden-flake assertion shape (2026-06 e2e audit). Scoped to the browser e2e suites (all three dirs the e2e-stop-rules source-scan also covers) + the rule's own fixture. Not workspace-wide: outside Playwright specs, `.count()` is usually not a Locator and the web-first rewrite does not apply.

Included: `packages/app/tests/stress/**/*.e2e.ts`, `packages/app/tests/visual/**/*.e2e.ts`, `packages/app/tests/a11y/**/*.e2e.ts`, `lint-plugins/ok-rules/__fixtures__/playwright-prefer-to-have-count.fixture.tsx`.

Rule: [`lint-plugins/ok-rules/rules/playwright-prefer-to-have-count.mjs`](rules/playwright-prefer-to-have-count.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/playwright-prefer-to-have-count.fixture.tsx`](__fixtures__/playwright-prefer-to-have-count.fixture.tsx). Test: [`packages/app/tests/lint-plugins/playwright-prefer-to-have-count.test.ts`](../../packages/app/tests/lint-plugins/playwright-prefer-to-have-count.test.ts). See [PRECEDENTS.md #42](../../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the custom-rule convention.

### `no-roundtrip-identity-oracle`

Forbids the byte-fidelity round-trip oracle in public-mirrored tests. Asserting that re-serializing a freshly-parsed document yields back the *same* input — `serialize(parse(x))` (or the MarkdownManager method form `m.serialize(m.parse(x))`) compared equal to that same `x` via `.toBe` / `.toEqual` / `.toStrictEqual` or `===` — is the engine's byte-identity correctness oracle, exercised by its own fidelity suite. A public test should pin a specific expected output instead; this rule keeps a new public test from reintroducing the general oracle.

**Identity, not contract.** The rule fires only when the parse input and the expected value are the *same expression* — the receiver-identity check (`$x` … `$x`) enforces textual equality. That is what separates the oracle from the assertions that must stay public and green:

- A **contract test** pins a *fixed expected literal* (`expect(serialize(parse('# H'))).toBe('# H\n')`) — the expected differs from the input, so it does not fire.
- The **Bridge-invariant comparator** `normalizeBridge(a) === normalizeBridge(b)` (precedent #38, the documented public contract) contains no `serialize(parse(...))` and is never flagged.
- The **normalizing-construct detector** `serialize(parse(x)) !== x` uses `!==`, a different operator, and is never flagged.

**Scoped** (see the rule's `RULE_SCOPES` entry in [`scope.mjs`](scope.mjs)) to the public-mirrored test surface (`packages/**/*.test.ts`, `*.test.tsx`, `*.e2e.ts`). The internal suites that legitimately own the oracle are excluded as negative globs (see the rule's `RULE_SCOPES` entry in `scope.mjs`); on this surface it is forbidden.

The rule does NOT catch:
- Round-trip identity through a helper (`mdRoundTrip(x)`, `normalize(...)`) or an intermediate variable (`const out = serialize(parse(x)); expect(out).toBe(x)`) — the pattern matches the inline call shape, not helper bodies or cross-statement data flow. Those forms live in the path-excluded fidelity suite, covered by exclusion.
- Equality through matchers other than `toBe` / `toEqual` / `toStrictEqual`, or operators other than `===` (e.g. a custom `assertByteIdentical` helper).
- Any oracle whose two sides are not the same inline expression (e.g. a round-trip compared to a different variable).

**Scope** (`RULE_SCOPES['no-roundtrip-identity-oracle']` in [`scope.mjs`](scope.mjs)). Byte-fidelity round-trip oracle ban. `serialize(parse(x))` (or the MarkdownManager method form) asserted equal to the same `x` is the engine's byte-identity correctness oracle; it is owned by internal suites excluded from this rule's scope entry, so a test on this surface can't reintroduce it. The fixture is in scope so its planted oracle drives the fixture-file test; the Bridge-invariant comparator `normalizeBridge(a) === normalizeBridge(b)` (precedent #38) is the public contract and is left untouched by the rule, not by this scope.

Included: `packages/**/*.test.ts`, `packages/**/*.test.tsx`, `packages/**/*.e2e.ts`, `lint-plugins/ok-rules/__fixtures__/no-roundtrip-identity-oracle.fixture.tsx`. Excluded: `packages/md-conformance/**`, `packages/app/tests/fidelity/**`, `packages/core/src/markdown/**/*.test.ts`, `packages/core/src/bridge/**/*.test.ts`, `**/*.private.*`.

Rule: [`lint-plugins/ok-rules/rules/no-roundtrip-identity-oracle.mjs`](rules/no-roundtrip-identity-oracle.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/no-roundtrip-identity-oracle.fixture.tsx`](__fixtures__/no-roundtrip-identity-oracle.fixture.tsx). Test: [`packages/app/tests/lint-plugins/no-roundtrip-identity-oracle.test.ts`](../../packages/app/tests/lint-plugins/no-roundtrip-identity-oracle.test.ts). See [PRECEDENTS.md #42](../../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the custom-rule convention and [PRECEDENTS.md #38](../../PRECEDENTS.md) for the Bridge-invariant contract.

### `no-hand-rolled-spinner`

Flags `animate-spin` in any `className` / `*ClassName` attribute value. Loading spinners come from the `Spinner` primitive so reduced-motion support and the accessible name are inherited rather than remembered per call site.

`animate-spin` applied by hand keeps spinning through `prefers-reduced-motion` (a vestibular trigger) and carries no role or label unless the author adds them. `Spinner` bakes in `motion-reduce:animate-none`, `role="status"`, and a localized `aria-label`. Pass `icon` when the glyph shape carries meaning (`RefreshCw` for syncing, `Undo2` for reverting), and `aria-hidden="true"` when a wrapper or enclosing control already names the loading state.

Suppress a legitimately non-`Spinner` spin (a decorative flourish, a non-loading rotation) with `// oxlint-disable-next-line ok/no-hand-rolled-spinner -- <reason>` on the line above the class attribute; the attribute must be on its own line for the suppression to attach.

Unscoped, like the other five rules in `UNSCOPED_RULES` — it applies wherever a class string can appear.

The `\b` delimiter is asymmetric in a way that is easy to misread: `animate-spinner` does NOT fire (the trailing boundary fails against a word character) but `animate-spin-slow` DOES (`-` is a boundary). That is the retired pattern's behaviour, kept deliberately — a slowed hand-rolled spin is still hand-rolled — and both halves are pinned in the fixture.

Rule: [`lint-plugins/ok-rules/rules/no-hand-rolled-spinner.mjs`](rules/no-hand-rolled-spinner.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/no-hand-rolled-spinner.fixture.tsx`](__fixtures__/no-hand-rolled-spinner.fixture.tsx). Test: [`packages/app/tests/lint-plugins/no-hand-rolled-spinner.test.ts`](../../packages/app/tests/lint-plugins/no-hand-rolled-spinner.test.ts).

### `no-inline-tolerance-class`

Forbids a public-mirrored test from writing a bridge normalization-class value inline as a string literal. `BRIDGE_TOLERANCE_CLASSES` (`packages/core/src/bridge/normalize.ts`) is the bridge normalizer's catalog of byte-difference equivalence classes it tolerates. A public test should assert observable `normalizeBridge` equivalence between inputs rather than hard-coding one of those class labels inline — the label is an internal classification detail, and pinning it inline both couples the test to that detail and re-declares the catalog outside the modules that own it. `check-mirror-test-policy` Check B already blocks a public test from *importing* the catalog symbol; this rule closes the complementary gap where a test re-encodes a class value inline (`expect(applied).toBe('jsx-container-boundary-blank')`, an array of class names), past the import check.

**Identity, not substring.** The `or {}` matches a string-literal node whose value *is* exactly a catalog member, so the names that appear legitimately on the public surface as prose are not flagged:

- A class name inside a longer **test-title sentence** (`test('… (block-separator-collapse class)', …)`) — a different node value, so it does not fire.
- A class name embedded in a **docName** with a prefix (`'fr34-doc-start-thematic'`) — likewise a substring, not the whole value.
- A class name in a **comment** — the rule matches the string-literal node, not trivia.

The match is quote-style independent (a single-quoted pattern matches the double-quoted form Biome emits). The four **universal text-encoding** classes — `bom`, `crlf`, `trailing-whitespace`, `trailing-newline` — are deliberately NOT matched: they are normalizations every text tool performs, not distinctive classes, and the public floor telemetry runtime (`tolerance-telemetry.ts`) surfaces them, so public tests legitimately assert that runtime emits `class: 'crlf'` for a CRLF input. The 12 markdown-fidelity classes plus those 4 universal classes partition the catalog exactly, and the fixture test's drift canary pins that partition — a class added to `BRIDGE_TOLERANCE_CLASSES` reddens until it is classified into one bucket.

**Scoped** (see the rule's `RULE_SCOPES` entry in [`scope.mjs`](scope.mjs)) to the public-mirrored test surface (`packages/**/*.test.ts`, `*.test.tsx`, `*.e2e.ts`), with the catalog-owning internal suites excluded as negative globs (see the rule's `RULE_SCOPES` entry in `scope.mjs`), so the catalog stays usable there but the inline form is forbidden on this surface.

The rule does NOT catch:
- A class name built by concatenation or template interpolation (`'doc-start-' + 'thematic'`) — neither operand is the whole value.
- A class name in a template literal — the pattern matches string-literal nodes, not template content.

**Scope** (`RULE_SCOPES['no-inline-tolerance-class']` in [`scope.mjs`](scope.mjs)). Inline bridge normalization-class value ban. BRIDGE_TOLERANCE_CLASSES (packages/core/src/bridge/normalize.ts) is the bridge normalizer's class catalog; importing it into a test on this surface is blocked by check-mirror-test-policy Check B, and this rule blocks the complementary inline re-encoding. The catalog is owned by internal suites excluded from this rule's scope entry, so `scoped()` returns an empty visitor for them and the rule body never runs there; the inline form cannot come back through a new test on that surface. The fixture is in scope so its planted literals drive the fixture-file test.

Included: `packages/**/*.test.ts`, `packages/**/*.test.tsx`, `packages/**/*.e2e.ts`, `lint-plugins/ok-rules/__fixtures__/no-inline-tolerance-class.fixture.tsx`. Excluded: `packages/md-conformance/**`, `packages/app/tests/fidelity/**`, `packages/core/src/markdown/**/*.test.ts`, `packages/core/src/bridge/**/*.test.ts`, `**/*.private.*`.

Rule: [`lint-plugins/ok-rules/rules/no-inline-tolerance-class.mjs`](rules/no-inline-tolerance-class.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/no-inline-tolerance-class.fixture.tsx`](__fixtures__/no-inline-tolerance-class.fixture.tsx). Test: [`packages/app/tests/lint-plugins/no-inline-tolerance-class.test.ts`](../../packages/app/tests/lint-plugins/no-inline-tolerance-class.test.ts). See [PRECEDENTS.md #42](../../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the custom-rule convention.

### `require-windowshide-on-spawn`

Windows console-flash prevention. Every hand-rolled `node:child_process` process-spawn (`spawn` / `spawnSync` / `execSync` / `execFile` / `execFileSync`, plus the repo aliases `nodeSpawn` and `execFileAsync`) must hide the Windows console it would otherwise pop — either by wrapping its options in `withHiddenWindowsConsole(...)` (from `@inkeep/open-knowledge-server`, the preferred form shared with the server package) or by an inline `windowsHide: true`.

**Why.** On Windows, `windowsHide` defaults to `false`. When a console-LESS parent — the OK server auto-started by an MCP host with `stdio: 'ignore'`, or spawned detached — spawns a console-subsystem binary like `git.exe`, Windows creates a new console window that flashes on screen and vanishes, once per spawn. During an editing / agent-write session the per-edit `git` reads produce a steady stream of these. Hiding the console fixes it. The flag is a **no-op on both macOS and Linux** (neither allocates a console for child processes), so it is applied uniformly regardless of the command's target platform.

`simple-git` already sets `windowsHide: true` internally, so git routed through it (shadow repo, share, conflicts) is out of scope by nature — this rule governs only the hand-rolled call sites that bypass it.

**Scoped** (see the rule's `RULE_SCOPES` entry in [`scope.mjs`](scope.mjs)) to `packages/{server,cli,desktop}/src/**/*.ts` (the packages that spawn processes at runtime on Windows), with `!**/*.test.ts` + `!**/*.test-helper.ts` excluded.

**Opting out (macOS/Linux-only spawns).** For a spawn that only ever runs on macOS and/or Linux — `codesign`, `sw_vers`, an `open(1)` launch — hiding a console is meaningless. Either add the flag anyway (a harmless no-op that keeps the rule uniform) or suppress that one call with a reason:

```ts
// oxlint-disable-next-line ok/require-windowshide-on-spawn -- macOS-only (never spawned on Windows)
const r = spawnSync('codesign', [...], { ... });
```

Reference opt-out in the tree: [`packages/cli/src/commands/diagnose-health-checks/macos-codesig.ts`](../../packages/cli/src/commands/diagnose-health-checks/macos-codesig.ts). Same-named wrapper false positives (a local `const spawn = deps.spawnDetached ?? …`, or an injected `spawn` param) use the same suppression with a "not node:child_process" reason.

The rule does NOT catch: bare `exec(...)` (the identifier is too commonly shadowed); member calls (`deps.spawn(...)` — a different AST, so the real impl behind the injection is the enforced site); a `windowsHide` / `withHiddenWindowsConsole` written inside a spawn's callback body (would spuriously satisfy the check — no realistic occurrence).

**Scope** (`RULE_SCOPES['require-windowshide-on-spawn']` in [`scope.mjs`](scope.mjs)). Windows console-flash prevention: every hand-rolled `child_process` spawn in the runtime-spawning packages must hide the Windows console (via `withHiddenWindowsConsole(...)` or `windowsHide: true`), else a console-less parent (MCP-spawned/detached OK server) flashes a terminal window per spawn on Windows. Scoped to the server, CLI, and desktop packages that spawn processes on Windows. Tests excluded. `simple-git` sets the flag internally, so git routed through it is out of scope by nature.

Included: `packages/server/src/**/*.ts`, `packages/cli/src/**/*.ts`, `packages/desktop/src/**/*.ts`, `lint-plugins/ok-rules/__fixtures__/require-windowshide-on-spawn.fixture.tsx`. Excluded: `**/*.test.ts`, `**/*.test-helper.ts`.

Rule: [`lint-plugins/ok-rules/rules/require-windowshide-on-spawn.mjs`](rules/require-windowshide-on-spawn.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/require-windowshide-on-spawn.fixture.tsx`](__fixtures__/require-windowshide-on-spawn.fixture.tsx). Test: [`packages/server/src/lint-plugins/require-windowshide-on-spawn.test.ts`](../../packages/server/src/lint-plugins/require-windowshide-on-spawn.test.ts). See [PRECEDENTS.md #42](../../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the custom-rule convention.

### `require-utf8-multipart-parser`

Multipart filename charset correctness. `busboy(...)` may only be constructed inside [`packages/server/src/multipart.ts`](../../packages/server/src/multipart.ts); every other multipart body is parsed through its `createMultipartParser(req, limits)` factory, which hardcodes `defParamCharset: 'utf8'`.

**Why.** busboy defaults `defParamCharset` to `latin1` — an inheritance from `Content-Disposition`'s original MIME/email definition, not from the `multipart/form-data` rules. RFC 7578 governs this surface instead. It issues no receiver mandate — section 5.1.3 is explicit that a parser cannot assume any particular charset was used — so the default is ours to choose, and UTF-8 is the only defensible choice: section 4.2 records that "the encoding used for the file names is typically UTF-8", and the sender-side form-charset ladder in section 5.1.2 terminates at UTF-8. Browsers and Node/undici both put the name on the wire as raw UTF-8 bytes in the plain `filename=` parameter, so at the default every multi-byte sequence is read back as one mojibake code point per byte: `café.png` arrives as `cafÃ©.png`, `会議メモ.pdf` loses essentially all of its information. The damage lands at the transport-decode boundary, before any sanitizer or storage layer sees it, and it is not invertible there — the mojibake is indistinguishable from a filename the user legitimately owns.

The omission is invisible in review: `busboy({ headers, limits })` reads as complete unless you happen to know the default. It shipped at two construction sites for exactly that reason, the second copied from the first along with its `limits` shape, which is why this is a mechanical gate rather than a review convention.

**Presence match, not absence match.** The sibling `require-windowshide-on-spawn` rule is shaped as "the call must contain `windowsHide`", because there the option's only correct value is `true`. That shape is too weak here: "the call must contain `defParamCharset:`" is satisfied by `defParamCharset: 'latin1'`, which passes lint and reintroduces the bug. The factory takes no charset parameter, so routing through it removes the value hole entirely and reduces this rule to a plain presence check on the constructor. Both the wrong-value and the right-value-wrong-place cases are pinned as must-fire fixtures.

**Scoped** (see [`scope.mjs`](scope.mjs)) repo-wide rather than per-package: server owns the only busboy dependency today, and that is exactly the state a new dependency elsewhere would change, silently. The sanctioned construction site and the test families are excluded. The `Included:` / `Excluded:` line below carries both halves, transcribed from `scope.mjs`, which is the entry the linter actually reads; this prose argues why the scope is shaped that way rather than restating it. The test exclusion is deliberate rather than copied: [`packages/server/src/http/local-api-dispatch.test.ts`](../../packages/server/src/http/local-api-dispatch.test.ts) drives its own parser inside a synthetic `/api/upload-lite` handler that counts bytes and never decodes a non-ASCII name.

**Opting out.** There is no legitimate second construction site. A caller that needs different parser options (`preservePath`, `highWaterMark`, …) should widen the factory — that keeps the charset decision in one place, and forces the path-traversal reasoning `preservePath` demands rather than letting it be set in passing. If you genuinely must construct in place, suppress the one call with a reason:

```ts
// oxlint-disable-next-line ok/require-utf8-multipart-parser -- <reason>
const bb = busboy({ headers, defParamCharset: 'utf8' });
```

The rule does NOT catch: member calls (`parsers.busboy(...)` — a different AST); a call through a renamed binding (`import bb from 'busboy'; bb(...)`). Both are defeatable on purpose rather than by accident. A `ReturnType<typeof busboy>` type annotation is not a call expression and correctly does not fire; it is pinned as a negative fixture so a future pattern change cannot silently start flagging type positions. The behavioural backstop for all of these is [`packages/app/tests/integration/api-error-envelope/upload-filename-charset.test.ts`](../../packages/app/tests/integration/api-error-envelope/upload-filename-charset.test.ts), which asserts the decode end to end over real HTTP through both endpoints.

**Scope** (`RULE_SCOPES['require-utf8-multipart-parser']` in [`scope.mjs`](scope.mjs)). Multipart filename charset: busboy may only be constructed inside `multipart.ts`, whose factory hardcodes `defParamCharset: 'utf8'`. busboy defaults that option to `latin1`, which mojibakes every non-ASCII filename at the transport-decode boundary, irreversibly and invisibly in review. Repo-wide rather than server-scoped: server owns the only busboy dependency today, and that is exactly the state a new dependency in another package would change, silently. The factory itself is excluded so it can make the one sanctioned call. Tests are excluded deliberately, not by copy: `http/local-api-dispatch.test.ts` drives its own parser in a synthetic `/api/upload-lite` handler that counts bytes and never decodes a non-ASCII name. The `.mts` extension in the include list matches one file today, `docs/vitest.real-source.config.mts`, and is carried mainly as forward coverage: this gate exists because the defect spread by copy-paste, so an extension it cannot see is a hole by construction. The sibling `class-proof-registration-discipline` entry carries the same extension: its predicate is a `CallExpression` visitor and its scope already reaches ordinary TypeScript, so nothing about that rule argues for excluding `.mts`.

Included: `**/*.ts`, `**/*.tsx`, `**/*.mts`, `lint-plugins/ok-rules/__fixtures__/require-utf8-multipart-parser.fixture.tsx`. Excluded: `**/node_modules/**`, `**/dist/**`, `**/*.test.ts`, `**/*.test.tsx`, `**/*.test.mts`, `**/*.test-helper.ts`, `packages/server/src/multipart.ts`.

Rule: [`lint-plugins/ok-rules/rules/require-utf8-multipart-parser.mjs`](rules/require-utf8-multipart-parser.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/require-utf8-multipart-parser.fixture.tsx`](__fixtures__/require-utf8-multipart-parser.fixture.tsx). Test: [`packages/server/src/lint-plugins/require-utf8-multipart-parser.test.ts`](../../packages/server/src/lint-plugins/require-utf8-multipart-parser.test.ts). See [PRECEDENTS.md #42](../../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the custom-rule convention.

### `no-blind-agent-host-fanout`

Scope discipline for user-global Agent Skill installs. Bans the `skills` CLI npm specs (`skills@~1.5.0` and its caret / exact / `latest` variants) and the bare `'--agent'` argv token anywhere under `packages/{server,cli}/src/**`.

**Why.** `installUserSkill` used to shell out to `npx -y skills@~1.5.0 add <dir> --agent '*' -g -y --copy`. `--agent '*'` makes that CLI skip its own host detection and target every host in its registry (~75 and growing), so a single `ok init` wrote 110 directories across 54 tool-config homes in a real `$HOME` — 51 of them for tools the reporter had never installed ([issue #820](https://github.com/inkeep/open-knowledge/issues/820)). OK's user-global skills are behavioural instructions autonomous software reads and acts on, so writing one into a tool's config dir is a scope-of-consent decision, not cosmetic clutter.

Nothing about the dependency was load-bearing: OK passed a local path (no source resolution), forced `--copy` (no symlinks), and the CLI writes no lockfile or state at global scope. It contributed a directory table that OK already maintains in core for project scope — while costing a floating-range `npx -y` fetch-and-execute at init time and third-party telemetry OK never opted out of. The install now writes directly, gated on `detectUserSkillHosts`, whose host set derives from `HOSTS_WITH_USER_SKILL_DIR` in [`packages/core/src/constants/editors.ts`](../../packages/core/src/constants/editors.ts).

The rule bans the *ingredients* rather than the assembled command line, because the argv was built as an array of literals that no single AST node spans.

**Scoped** (see the rule's `RULE_SCOPES` entry in [`scope.mjs`](scope.mjs)) to `packages/{server,cli}/src/**/*.ts`. Tests are deliberately **in** scope (unlike the sibling spawn rule): a test that reintroduces the invocation reintroduces the fan-out, and the suite asserts the writer's behavior through the filesystem, never through argv.

The rule does NOT catch a spec assembled by concatenation or interpolation (`` `skills@${range}` ``), or the flag reaching a subprocess through a variable — the rule matches the string-literal node. Both are defeatable-on-purpose rather than accidental; the behavioural backstop is [`packages/server/src/skill-install.test.ts`](../../packages/server/src/skill-install.test.ts), whose "never creates a dotdir for a host that is not installed" case asserts the real filesystem outcome.

Adding a host that needs a different install mechanism? Add it to `HOSTS_WITH_USER_SKILL_DIR` and let the detection gate cover it — don't suppress this rule.

**Scope** (`RULE_SCOPES['no-blind-agent-host-fanout']` in [`scope.mjs`](scope.mjs)). Scope discipline for user-global Agent Skill installs (issue #820). OK writes these dirs itself, gated on `detectUserSkillHosts`; shelling out to the `skills` CLI with `--agent '*'` bypasses host detection and creates config dirs for tools the user never installed. Scoped to server + cli (where the user-global install lives). Tests are NOT excluded — a test reintroducing the invocation is as load-bearing as production code, and the suite asserts through the filesystem, never through argv.

Included: `packages/server/src/**/*.ts`, `packages/cli/src/**/*.ts`, `lint-plugins/ok-rules/__fixtures__/no-blind-agent-host-fanout.fixture.tsx`.

Rule: [`lint-plugins/ok-rules/rules/no-blind-agent-host-fanout.mjs`](rules/no-blind-agent-host-fanout.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/no-blind-agent-host-fanout.fixture.tsx`](__fixtures__/no-blind-agent-host-fanout.fixture.tsx). Test: [`packages/app/tests/lint-plugins/no-blind-agent-host-fanout.test.ts`](../../packages/app/tests/lint-plugins/no-blind-agent-host-fanout.test.ts). See [PRECEDENTS.md #42](../../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the custom-rule convention.

### `no-unwrapped-user-facing-string`

Localization discipline. Makes a hardcoded user-facing string a **build-visible defect** rather than a convention someone has to remember — the gap that let the app accumulate residual English while the `en` catalog grew past 2,800 entries. Four surfaces:

- **Toast arguments** — `toast.error('…')`, `toast.success('…')`, any `toast.<method>` whose first argument is a string literal.
- **JSX text children** — `<span>No documents match your search</span>`.
- **UI-facing attributes** — `aria-label`, `placeholder`, `title`, `alt` with a string-literal value.
- **UI-facing object properties** — `{ label: 'Delete table' }`, `{ description: 'Link to a page or external URL' }`. Same six names as the attribute branch plus `label` and `description`.

The wrapped forms — `<Trans>…</Trans>`, `` t`…` `` from `useLingui()` / `@lingui/core/macro` — are not literals in the positions above and never fire.

**Why object position needed its own branch.** `{ title: '…' }` renders the same words `title="…"` renders, but the attribute branch cannot see it, and that shape was where the residual English actually was: a sweep found 50 of them (menu items, picker entries, hover-preview panels, user-shown error envelopes) against zero the other three branches could reach. The name scope is what keeps it usable — the same measurement that produced the JSX prose test applies here, since an unscoped literal rule fires on every `className`, `data-testid`, and identifier in the tree. With the six names and the prose test, the branch found **1 hit in `packages/app/src`** after the migration landed, and that one is a deliberate non-copy label carrying a `biome-ignore`.

**Implementation note.** The object-property branch visits `Property` nodes directly and keys on the property name, so the branch is written as the code snippet `` `$name: $value` ``. That binds to JS object-literal pairs only: a TypeScript member such as `label: 'left' | 'right'` inside a `type` or `interface` is a different node and is structurally out of reach, which is what keeps string-literal union types from firing.

**Where a `msg` descriptor is the fix instead of `t`.** When the object is module scope — a `const` array of menu items, a severity table, a language list — a `t` call in it resolves once at import and then keeps whatever language was active then, however correctly it is wrapped. `I18nProvider` re-renders context *consumers*, not the whole tree, so nothing corrects it later. Hold a `msg` descriptor in the object and resolve it with `t(descriptor)` at render, in a component that calls `useLingui()`; that hook call is also what subscribes the component to the locale change. `BlockTypeSelector.tsx` and `editor/utils/severity.ts` are the reference shapes.

**The prose test, and why the branches differ.** The two JSX branches require **two letter-words separated by whitespace**; the toast branch takes any literal. That asymmetry is measured, not stylistic: a toast argument is unambiguously user-facing, whereas raw JSX text in this codebase is overwhelmingly *not* prose. Firing on every JSX literal produced 53 hits across the product tree of which **zero** were genuine copy — keyboard-shortcut tokens (`Ctrl+Shift+N`), code identifiers (`open-knowledge`), sample paths (`notes / release-plan.md`), and brand marks (`OpenKnowledge`). With the prose test the same sweep produced **4 hits, all real** (two `aria-label`s and one banner sentence in `ConflictsSection.tsx`, one toast in `FileTree.tsx`), which is the signal-to-noise ratio that makes a lint rule worth obeying. Note the two-word test also excludes tokens joined by punctuation, since `notes / release-plan.md` has no letter–space–letter run.

`<Brand> icon` is exempt in-pattern: it is the accessible name of a third-party mark, and translating it renames the product.

**Scoped** (see the rule's `RULE_SCOPES` entry in [`scope.mjs`](scope.mjs)) to `packages/{app,desktop,plugin}/src/**`, `.ts` as well as `.tsx` — the toast branch's dominant shape is a plain `lib/` helper, not a component. Exemptions as negative `!`-globs: `!packages/app/src/editor/**` (ProseMirror/CodeMirror-managed views, whose placeholder and title strings are editor affordances), `!packages/app/src/components/ui/**` (shadcn primitive wrappers — attribute strings there are prop plumbing), `!packages/desktop/src/main/**` (the Electron main process — see below), and `!**/*.test.ts` / `!**/*.test.tsx` / `!**/*.dom.test.tsx`.

`packages/desktop/src/main/**` is excluded because `lingui extract` reads `packages/app/src` only, so a `t` macro written there reaches no catalog; main's one translated surface, the native menus, goes through `main-i18n.ts`, which looks its labels up by hash against the renderer's compiled catalogs. The object-property branch fires on 20 of main's `dialog.showMessageBox` templates and OTel metric descriptions, and asking for a fix that does not exist is how a rule earns a blanket suppression. Main's four sibling dirs (`preload` / `renderer` / `shared` / `utility`) stay in scope.

The rule does NOT catch:

- **Single-word JSX copy** — `<Button>Save</Button>`. The known cost of the prose test; nothing statically separates `Save` from `Discord`. The backstop is the Simplified-Chinese coverage sweep, where residual English is unmissable against Han script.
- **Object properties outside the six scoped names** — `{ message: 'Server returned…' }`, `{ error: '…' }`, `{ detail: '…' }`. Measured rather than assumed: those three names are dominated by log lines and developer diagnostics (`{ detail: 'copilot is terminal-only; launch via requestTerminalLaunch' }`), so scoping them in would make the rule's first act a demand to translate something no reader ever sees. The user-shown members of that set were wrapped by hand.
- **Module-const strings** — `const TOAST = '…'`. Not a property; a separate shape, and one where a `t` at module scope would be a freeze rather than a fix.
- **A ternary or call in property position** — `{ error: e instanceof Error ? e.message : 'Unknown error' }`. the rule matches the whole node's text, so the value has to *be* a literal; a value that merely *contains* one would also match `{ label: cn('a b') }`.
- **A JSX expression-child string literal** — `<span>{'Loading'}</span>`, or an attribute written `aria-label={'…'}`. The value node opens with `{`, which is what distinguishes a literal from a wrapped macro.
- **Template literals** anywhere, including a toast `description`.
- **The CLI command surface** — `packages/cli/src/**`, deliberately never localized.

**Scope** (`RULE_SCOPES['no-unwrapped-user-facing-string']` in [`scope.mjs`](scope.mjs)). Localization discipline — a shipped hardcoded string is a build-visible defect, not a convention someone has to remember. Scoped to packages/{app,desktop,plugin}/src, `.ts` included: the toast branch's dominant shape is a plain `lib/` helper, not a component. Exemptions: - packages/app/src/editor/** — ProseMirror/CodeMirror-managed views, whose placeholder and title strings are editor affordances rather than chrome copy (matches the no-raw-html-interactive-element exemption). - packages/app/src/components/ui/** — shadcn primitive wrappers; their attribute strings are prop plumbing, not copy. - packages/desktop/src/main/** — the Electron main process. `lingui extract` reads packages/app/src only, so a `t` macro here reaches no catalog; main's one translated surface (the native menus) goes through `main-i18n.ts`, which looks labels up by hash against the renderer's compiled catalogs. Firing on its dialog templates would ask for a fix that does not exist. The other four sibling dirs (preload / renderer / shared / utility) stay in scope. - *.test.ts / *.test.tsx / *.dom.test.tsx — test fixtures aren't user-facing.

Included: `packages/app/src/**/*.ts`, `packages/app/src/**/*.tsx`, `packages/desktop/src/**/*.ts`, `packages/desktop/src/**/*.tsx`, `packages/plugin/src/**/*.ts`, `packages/plugin/src/**/*.tsx`, `lint-plugins/ok-rules/__fixtures__/no-unwrapped-user-facing-string.fixture.tsx`. Excluded: `packages/app/src/editor/**`, `packages/app/src/components/ui/**`, `packages/desktop/src/main/**`, `**/*.test.ts`, `**/*.test.tsx`, `**/*.dom.test.tsx`.

Rule: [`lint-plugins/ok-rules/rules/no-unwrapped-user-facing-string.mjs`](rules/no-unwrapped-user-facing-string.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/no-unwrapped-user-facing-string.fixture.tsx`](__fixtures__/no-unwrapped-user-facing-string.fixture.tsx). Test: [`packages/app/tests/lint-plugins/no-unwrapped-user-facing-string.test.ts`](../../packages/app/tests/lint-plugins/no-unwrapped-user-facing-string.test.ts). See [PRECEDENTS.md #42](../../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the custom-rule convention.

### `no-physical-direction-utility`

Reading-direction discipline. Chrome layout takes its side from the reading direction, never from a hardcoded left or right, so that adding a right-to-left locale is a catalog change rather than a chrome-wide retrofit. The rule flags physical **margin**, **padding**, and **inset** Tailwind utilities — `ml-`/`mr-`, `pl-`/`pr-`, `left-`/`right-` — and asks for `ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-` instead. In a left-to-right locale the two compile to the same used value, so draining the backlog is a visual no-op today and correct later.

**It matches class strings, not stylesheets.** That is where this codebase's physical properties live: the sweep that produced this rule found 148 of them in `className` values against 31 CSS declarations, and 24 of those 31 style the editor or the rendered document rather than the chrome. One `jsx_attribute` branch covers both spellings, because the bound node is the whole initializer clause — a plain `className="ml-2 flex"` and a multi-line `className={cn('…', cond && 'pr-1.5')}` are the same node to the pattern. The name is matched as `*lassName`, so component APIs that forward a second class string (`containerClassName`, `overflowClassName`) are in scope under their own names.

**Two shapes look physical and are not, and both are measured rather than assumed:**

- **`inset-x-*` is already logical.** Tailwind v4 compiles `inset-x-0` to `inset-inline: 0`. It is absent from the pattern for that reason, not as a carve-out.
- **`left-1/2` is the centering anchor.** It exists to be cancelled by the `-translate-x-1/2` beside it, and at 50% the offset is symmetric, so it centers correctly in both directions; `start-1/2` would flip the anchor while the translate kept pulling the same way. The pattern requires a delimiter after a numeric value, which leaves every fractional inset alone — all 10 `left-1/2` sites in the tree carry that translate.

**Scoped** (see the rule's `RULE_SCOPES` entry in [`scope.mjs`](scope.mjs)) to `packages/{app,desktop,plugin}/src/**/*.tsx`. `.tsx` only: the single branch matches a JSX attribute, so a `.ts` glob would be dead scope rather than extra coverage. Exemptions as negative `!`-globs: `!packages/app/src/editor/**` (ProseMirror and CodeMirror own their DOM and take per-string direction from the text rather than from the chrome), `!packages/app/src/components/ui/**` (shadcn primitives are regenerated by `shadcn add`, so an edit there is overwritten on the next pull), and `!**/*.test.tsx` / `!**/*.dom.test.tsx`.

**Pre-rule backlog (ratchet pattern).** The 81 files that pre-date the rule carry a file-level `// oxlint-disable ok/no-physical-direction-utility -- pre-rule backlog — …` header, same contract as `no-raw-html-interactive-element`: the comment list across the codebase IS the visible backlog, and review treats each header as a backlog marker rather than a free pass. Drain a file by swapping `ml`/`mr` → `ms`/`me`, `pl`/`pr` → `ps`/`pe`, `left`/`right` → `start`/`end`, then deleting the header — the rule starts firing again immediately, so a partial pass that misses one utility fails the gate. 81 of the 292 chrome files in scope carry a header (148 utilities in total), so the rule is live on the other 211 today.

The rule does NOT catch:

- **Class strings outside a class prop** — `{ containerClassName: 'bottom-3 left-3' }` as an object-literal property, or a module-level `const ROW = 'ml-2 flex'`. Five sites in the tree: four object-literal properties in `GraphLegend.tsx`, one const in `editor-tabs-chrome.ts`. A hand fix, not a rule — the name predicate keys on a JSX attribute, and widening it to every string-valued property is the false-positive surface the negative cases below the fixture's group 6 exist to bound.
- **Fractional insets** — `left-1/3` alongside the `left-1/2` the exclusion is aimed at. One site, and separating them costs more regex than it buys.
- **CSS declarations** — `margin-left:` in `globals.css` (25 sites) or inside a `unsafeCSS` template literal (6, all in the file-tree and skill-cluster shadow styles). A `language css` plugin would reach the stylesheet — verified working in Biome 2.4.15 — but not the template literals, and 24 of the 25 stylesheet sites style the editor or the rendered document, surfaces this rule exempts anyway. One chrome site remains: `.tabs-strip-add`.
- **Physical `border-*`, `rounded-*`, and `text-left`/`text-right`** — real direction hazards, outside this rule's margin/padding/inset scope.

**Scope** (`RULE_SCOPES['no-physical-direction-utility']` in [`scope.mjs`](scope.mjs)). Reading-direction discipline. The rule's only branch matches a JSX attribute, so the scope is `.tsx` alone — a `.ts` glob would be dead scope, not extra coverage. Exemptions: - packages/app/src/editor/** — ProseMirror/CodeMirror own their DOM and take per-string direction from the text rather than from the chrome (matches the no-raw-html-interactive-element exemption). - packages/app/src/components/ui/** — shadcn primitives are regenerated by `shadcn add`, so an edit here is overwritten on the next pull. - *.test.tsx / *.dom.test.tsx — fixtures aren't rendered chrome.

Included: `packages/app/src/**/*.tsx`, `packages/desktop/src/**/*.tsx`, `packages/plugin/src/**/*.tsx`, `lint-plugins/ok-rules/__fixtures__/no-physical-direction-utility.fixture.tsx`. Excluded: `packages/app/src/editor/**`, `packages/app/src/components/ui/**`, `**/*.test.tsx`, `**/*.dom.test.tsx`.

Rule: [`lint-plugins/ok-rules/rules/no-physical-direction-utility.mjs`](rules/no-physical-direction-utility.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/no-physical-direction-utility.fixture.tsx`](__fixtures__/no-physical-direction-utility.fixture.tsx). Test: [`packages/app/tests/lint-plugins/no-physical-direction-utility.test.ts`](../../packages/app/tests/lint-plugins/no-physical-direction-utility.test.ts). See [PRECEDENTS.md #42](../../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the custom-rule convention.

### `no-raw-route-hash-construction`

Sole route-hash builder. [`packages/app/src/lib/doc-hash.ts`](../../packages/app/src/lib/doc-hash.ts) owns the `#/` route prefix. Every other file in the app asks it for a hash — `hashFromDocName`, `hashFromFolderPath`, `hashFromAssetPath` or `encodeShareTargetForHash` — rather than joining a name onto the prefix itself.

**Why.** A doc or folder name reaches the router through `window.location.hash`, and the WHATWG fragment percent-encode set does not include `#`, `?` or `%`. A hash built by hand therefore hands those characters to `docNameFromHash` as routing syntax: it reads the text before the first one, so a leading `#` yields null and the app opens a New Tab instead of the document, while a `#` mid-name resolves silently to a truncation. The rule is structural rather than a set of fixes because the prefix is trivially easy to spell, so hand-built copies accumulate faster than they are found, and each one fails silently: the link is still built, it just points somewhere else.

**Scoped** (see the rule's `RULE_SCOPES` entry in [`scope.mjs`](scope.mjs)) to `packages/app/src/**/*.{ts,tsx}`, with `!packages/app/src/lib/doc-hash.ts` (the sanctioned builder) and `!**/*.test.{ts,tsx}` (tests write expected hashes as literals) excluded. `packages/server` builds preview URLs through its own `encodeDocName` and is out of scope.

Reading a hash is untouched: `hash.startsWith('#/')`, `hash === '#/'` and the bare `'#/'` content-root sentinel are comparisons, not constructions, and the fixture pins that they stay legal.

The rule matches a node's own source text, so a comment, JSX text or a regex literal spelling the shape cannot trigger it — the fixture pins all three. The rule does NOT catch: the prefix behind a named constant (`const P = '#/'; P + name`), which needs dataflow and has no occurrence today; `name + '#/'`, the prefix on the right of a concatenation, which does not build a route hash; a helper that takes the prefix as a parameter; and the read side, where [`editor/internal-link-helpers.ts`](../../packages/app/src/editor/internal-link-helpers.ts) still carries a hand-rolled parser — a different rule.

**Scope** (`RULE_SCOPES['no-raw-route-hash-construction']` in [`scope.mjs`](scope.mjs)). Sole route-hash builder. `lib/doc-hash.ts` owns the `#/` prefix; every other file in the app asks it for a hash. Building one by hand emits the doc name unescaped, and the browser leaves `#`, `?` and `%` alone in a fragment, so the parser reads them as routing syntax and the navigation lands somewhere else. Excluded: `lib/doc-hash.ts` itself (the sanctioned site) and tests, which build expected hashes as literals. `packages/server` has its own `encodeDocName` for preview URLs and is out of scope.

Included: `packages/app/src/**/*.ts`, `packages/app/src/**/*.tsx`, `lint-plugins/ok-rules/__fixtures__/no-raw-route-hash-construction.fixture.tsx`. Excluded: `packages/app/src/lib/doc-hash.ts`, `**/*.test.ts`, `**/*.test.tsx`.

Rule: [`lint-plugins/ok-rules/rules/no-raw-route-hash-construction.mjs`](rules/no-raw-route-hash-construction.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/no-raw-route-hash-construction.fixture.tsx`](__fixtures__/no-raw-route-hash-construction.fixture.tsx). Test: [`packages/app/src/lint-plugins/no-raw-route-hash-construction.test.ts`](../../packages/app/src/lint-plugins/no-raw-route-hash-construction.test.ts). See [PRECEDENTS.md #42](../../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the custom-rule convention.

### `no-demoted-dialog-confirm`

Dialog-footer emphasis hierarchy. A confirmation dialog's footer holds two actions, and the confirm has to outrank the dismiss. `secondary` is the one Button variant that draws no border and whose fill is imperceptible: `bg-secondary` sits within roughly 1.1:1 of the dialog surface in both light and dark, so the button reads as flat text rather than an action. `ghost`, `link` and `link-muted` are flat at rest too, so `secondary` is not the only variant that could lose the contest with the `outline` Cancel standing beside it. The rule stays narrow to `secondary` because those three are not plausible footer confirms: `ghost` and `link-muted` are `text-muted-foreground` by definition, and `link` is underline-on-hover text. Nobody reaches for them intending a primary action, so flagging them would report a shape that does not occur rather than an inversion someone authored by accident. Every remaining variant either fills with a contrasting color or draws a border. A footer authored that way inverts the hierarchy: the escape action reads as the primary one, and the actual primary CTA reads as de-emphasized text. The rule flags a `DialogFooter` or `AlertDialogFooter` containing `variant="secondary"` and asks for `default` (or `destructive`, when the action is irreversible removal).

**The typographic treatment comes from the footer, not the variant.** `DialogFooter` and `AlertDialogFooter` carry `[&_button]:` and `[&_[data-slot=button]]:` pairs of `font-mono uppercase`, so every footer action is drawn in the footer's typeface whatever variant it takes. Nothing needs hand-adding at a call site, and a `className="font-mono uppercase"` on a footer button is redundant rather than load-bearing. `default`, `destructive` and `outline-mono` also bake the pair into their variant strings — that is what dresses them outside a footer, so do not delete it on the strength of this paragraph.

**Why two selectors rather than one.** Neither predicate covers every footer shape on its own, so the rule is their union:

| Footer action | `button` element | `[data-slot=button]` |
| --- | --- | --- |
| plain `<Button>` | yes | yes |
| `<Button asChild>` rendering an `<a>` | no | yes |
| `AlertDialogCancel` / `AlertDialogAction` | yes | no |
| `DialogClose asChild` wrapping a `Button` | yes | no |

Radix's `Slot` lets the child's `data-slot` win, so the three wrapper primitives stamp their own slot name and fall out of a slot-only selector; `<Button asChild>` rendering an anchor is not a `<button>` element and falls out of a tag-only one. Keying on both covers all five. Keep the descendant combinator: `ShareBranchSwitchDialog` wraps three footer buttons in a `<div>`, which a child-scoped variant would miss.

Two consequences worth knowing before you fight them:

- **The footer outranks the button.** The compiled rule is `.…\:font-mono button { … }` at specificity `(0,1,1)`; a class on the button itself is `(0,1,0)` and loses, and `tailwind-merge` cannot arbitrate because the two declarations sit on different elements. Opting one footer button out of the treatment therefore needs the important modifier — `font-sans!` / `normal-case!` — not a plain utility.
- **A footer action that is neither a `<button>` nor a `Button` styles itself.** The bare `<a>` in `InstallInClaudeDesktopDialog`'s footer is the one live instance, and it carries its own `font-mono tracking-wide uppercase`. That is deliberate: the footer dresses the design system's buttons, and a hand-rolled action carries its own treatment. Promoting such a link to `<Button asChild>` brings it under the rule.

Historically the two sites this rule was written against had reached for `variant="secondary"` plus a hand-added `className="font-mono uppercase"`, which recovered the footer's typography while leaving the confirm without a perceptible fill. That is what makes the inversion easy to author by accident: the footer still looks like a footer. The canonical shape omits the prop entirely and lets `defaultVariants` supply `default`, matching every other confirm dialog in the tree.

**Matched as one whole JSX element.** The rule visits the footer element and tests its full source text, because a footer holds two or more children and the confirm can sit at any position among them. Testing the whole element text matches the entire node text, so the leading tag name anchors the match to footers themselves rather than to any ancestor that happens to contain one.

**Scoped** (see the rule's `RULE_SCOPES` entry in [`scope.mjs`](scope.mjs)) to `packages/{app,desktop,plugin}/src/**/*.tsx`. `.tsx` only: the single branch matches a JSX element, so a `.ts` glob would be dead scope rather than extra coverage. Exemptions as negative `!`-globs: `!packages/app/src/components/ui/**` (the dialog and button primitives themselves, regenerated by `shadcn add`), and `!**/*.test.tsx` / `!**/*.dom.test.tsx` (a test that renders the demoted shape on purpose is pinning the regression, not shipping it).

The rule does NOT catch:

- **Indirect composition.** A confirm passed into the footer as a prop, or rendered by a shared sub-component, sits outside the footer element's text. The ceiling is deliberate: it keeps the rule to one structural predicate rather than a type-aware analysis.
- **The other direction.** A footer whose dismiss is over-emphasized (a `default` Cancel next to a `default` confirm) is a hierarchy problem this rule has no predicate for, since both buttons carry a fill.
- **Non-footer emphasis inversions.** A `CardFooter` or toolbar pairing a muted primary action with a prominent secondary one. `secondary` outside a dialog footer is a legitimate choice, which is why the scope is the footer element.

Suppress a footer that genuinely wants a muted tertiary control alongside a properly-weighted confirm with an inline `// oxlint-disable-next-line ok/no-demoted-dialog-confirm -- <reason>`.

**Scope** (`RULE_SCOPES['no-demoted-dialog-confirm']` in [`scope.mjs`](scope.mjs)). Dialog-footer emphasis hierarchy. `secondary` is the one Button variant whose fill is low enough in contrast to lose the emphasis contest with the `outline` dismiss standing beside it — a footer authored that way reads with its hierarchy inverted. The rule's only branch matches a JSX element, so the scope is `.tsx` alone; a `.ts` glob would be dead scope, not extra coverage. Exemptions: - packages/app/src/components/ui/** — the dialog and button primitives themselves, regenerated by `shadcn add` (matches the no-physical-direction-utility exemption). - *.test.tsx / *.dom.test.tsx — fixtures aren't rendered chrome, and a test that renders the demoted shape on purpose is pinning the regression, not shipping it.

Included: `packages/app/src/**/*.tsx`, `packages/desktop/src/**/*.tsx`, `packages/plugin/src/**/*.tsx`, `lint-plugins/ok-rules/__fixtures__/no-demoted-dialog-confirm.fixture.tsx`. Excluded: `packages/app/src/components/ui/**`, `**/*.test.tsx`, `**/*.dom.test.tsx`.

Rule: [`lint-plugins/ok-rules/rules/no-demoted-dialog-confirm.mjs`](rules/no-demoted-dialog-confirm.mjs). Fixture: [`lint-plugins/ok-rules/__fixtures__/no-demoted-dialog-confirm.fixture.tsx`](__fixtures__/no-demoted-dialog-confirm.fixture.tsx). Test: [`packages/app/tests/lint-plugins/no-demoted-dialog-confirm.test.ts`](../../packages/app/tests/lint-plugins/no-demoted-dialog-confirm.test.ts). See [PRECEDENTS.md #42](../../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the custom-rule convention.

## Suppression

Inline `// oxlint-disable-next-line` comments silence individual diagnostics. The form names the plugin, the rule and the reason:

```tsx
// oxlint-disable-next-line ok/<rule-name> -- <reason>
<span>…</span>
```

Two scopes, and the choice between them is meaningful:

- `// oxlint-disable-next-line ok/<rule-name> -- reason` silences the next line. Use it for a genuine one-off exception.
- `// oxlint-disable ok/<rule-name> -- reason` at the top of a file silences the whole file. Use it **only** as a pre-rule backlog marker (see the ratchet contract in the rule's section above), never to opt a new file out.

The `--` separator is required; oxlint reads everything after it as the reason. These replaced biome's `// biome-ignore lint/plugin/<rule>: <reason>` and `// biome-ignore-all` pair, which oxlint does not honour.

Current production suppressions:

| rule | line-level | file-level (backlog) |
| - | - | - |
| `no-physical-direction-utility` | 2 | 78 |
| `no-loosely-typed-webcontents-ipc` | 31 | 0 |
| `no-raw-html-interactive-element` | 0 | 20 |
| `no-unportaled-editor-content` | 7 | 0 |
| `require-windowshide-on-spawn` | 6 | 0 |
| `microcopy-ellipsis` | 2 | 0 |
| `no-unwrapped-user-facing-string` | 1 | 0 |
| `no-hand-rolled-spinner` | 1 | 0 |

Every other rule has zero. The two file-level columns are the visible migration backlogs: 78 files awaiting the logical-property pass, 20 awaiting shadcn migration.

**Where an inline suppression can and cannot sit.** A suppression comment needs a line of its own directly above the reported span, which is a property of the *formatting* rather than of the rule. On a JSX attribute that means the attribute must already be on its own line. A `{/* oxlint-disable-next-line */}` child covers the element that follows it, not a text node that starts after that element.

## Adding a new rule

### 1. Author the rule module

Drop `<rule-name>.mjs` in `rules/`. A rule is an ESLint-shaped visitor object; `context.report({ node, message })` emits the diagnostic:

```js
import { docsUrl } from '../docs.mjs';

const URL = docsUrl('<rule-name>');
const MESSAGE = `<problem>. <fix-noun>. See ${URL}`;

export const ruleName = {
  meta: {
    type: 'problem',
    docs: { description: '<one line>', url: URL },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!/* matches */ false) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
};
```

**No prose comments.** Rule modules are `.mjs` and the [no-comments policy](../no-comments/README.md) applies. Rationale goes in this README, in the rule's own section.

**Message shape (load-bearing).** The diagnostic message has three parts in order: (1) the problem statement, (2) the fix-noun naming the action that resolves it, (3) `See <docs-URL>` built by `docsUrl('<rule-name>')` so no message hand-writes the base URL.

### 2. Register the rule

Import it in [`index.mjs`](index.mjs), add it to the `declared` map, then switch it on in [`oxlint.config.ts`](../../oxlint.config.ts) as `'ok/<rule-name>': 'error'`.

A small number of rules are registered from a second plugin instead of this one. If the rule you are adding documents a calibrated measurement, an internal file list, or anything else that should not reach a public clone, do not follow this step as written. That path is documented in a maintainers-only checklist that is not part of this clone; if you cannot reach it, open an issue describing what the rule would enforce and leave the registration to a maintainer rather than guessing at the shape.

### 3. Scope it, if it is not workspace-wide

Add a `RULE_SCOPES['<rule-name>']` entry in [`scope.mjs`](scope.mjs): an array of globs where a leading `!` excludes. A file is in scope when it matches at least one positive glob and no negative one. Include the rule's own fixture path so the fixture test can fire.

Scope lives here rather than in `oxlint.config.ts#overrides` because **oxlint's `overrides[].files` does not honour `!` negation** (measured on oxlint 1.66.0: with the rule `off` at root and an override of `files: ['lint-plugins/ok-rules/__fixtures__/**', '!**/*.fixture.tsx']`, the rule still fired on the excluded fixture — the negative glob did not subtract from the positive one. Re-check this on an oxlint upgrade; if negation lands, this whole scope table becomes revisitable) — a negative glob in that list does not subtract from a positive one, so an override-scoped rule silently fires on its exclusions. Biome's `includes` did honour it, which is why the rules this replaced could scope in config.

### 4. Author the fixture file

Drop `<rule-name>.fixture.tsx` in `__fixtures__/`, pairing positive cases (must fire) with negative cases (must NOT fire), each labelled. Include a boundary negative: the nearest shape the rule must NOT match. The directory is in `oxlint.config.ts#ignorePatterns` so the deliberately-bad content does not break the main lint; `__fixtures__/oxlint.fixtures.json` re-enables every rule for the tests.

### 5. Author the fixture-file test

Shell out to oxlint against the fixture config and assert an exact count:

```ts
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE = 'lint-plugins/ok-rules/__fixtures__/<rule-name>.fixture.tsx';
const CONFIG = 'lint-plugins/ok-rules/__fixtures__/oxlint.fixtures.json';

describe('<rule-name> oxlint rule', () => {
  test('fires on exactly N positive cases (and on no negative case)', () => {
    const result = spawnSync('pnpm', ['exec', 'oxlint', '-c', CONFIG, FIXTURE], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect((output.match(/ok\(<rule-name>\)/g) ?? []).length).toBe(N);
    expect(output).toContain('<fix-noun>');
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('lint-plugins/ok-rules/README.md#<rule-name>');
  });
});
```

Exact equality is the point: it catches false-negative regressions (count drops below N) and false-positive widenings (count rises above N) alike.

### 6. Verify

```bash
# 1. Rule loads and the main lint stays clean:
pnpm run lint:oxlint

# 2. Fixture test fires the diagnostic on positive cases:
pnpm --dir packages/<host> exec vitest run <rule-name>

# 3. Mutation check (manual, one-time during dev):
#    Temporarily break the rule's predicate; re-run the test; confirm it FAILS;
#    restore it; re-run; confirm it passes.

# 4. False-positive widening check (manual, one-time):
#    Add a positive case to the fixture WITHOUT bumping N in the test.
#    Re-run; confirm it FAILS. This verifies toBe(N) is load-bearing.
```

### 7. Document the rule in this README

Add a `### \`<rule-name>\`` section: what it catches, what it deliberately does NOT catch, the `**Scope**` note if it is scoped, and the Rule / Fixture / Test links. The anchor must match `docsUrl('<rule-name>')`, i.e. `#<rule-name>`, because the fixture test asserts the message links here.

## Out of scope

- **Autofix.** oxlint JS-plugin diagnostics are diagnostic-only here; these rules name the fix rather than applying it. If autofix is required, a different enforcement mechanism is needed.
- **Type-aware discrimination.** These rules run on the untyped AST. Where the type system carries the discriminating signal, precedent #42's decision tree routes to a TypeScript Language Service plugin instead.
- **CLI string content.** `process.stderr.write('...')` / `console.log` template-literal content is not reliably matchable and is left to review discipline.

## References

- [oxlint custom JS plugins](https://oxc.rs/docs/guide/usage/linter/plugins.html)
- [PRECEDENTS.md #42](../../PRECEDENTS.md#custom-lint-enforcement-precedent-42) — the custom-lint-enforcement convention
- [`lint-plugins/no-comments/README.md`](../no-comments/README.md) — the sibling oxlint plugin and the comment policy that governs these modules
