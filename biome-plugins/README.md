# Biome GritQL plugins

Custom lint rules for this workspace, registered in [`biome.jsonc`](../biome.jsonc) at the top-level `plugins` array (workspace-wide) OR a scoped `overrides[].plugins` entry (file-specific — used when the rule's invariant only applies to a known subset of files). Each `.grit` file is a single GritQL pattern (or `or { ... }` of patterns) emitting diagnostics via `register_diagnostic()`.

Plugins surface as lint errors during `biome check` (i.e. `pnpm lint` and `pnpm check`) and as inline editor squiggles via the Biome LSP.

## Convention

**All custom Biome lint enforcement uses GritQL plugins** — [PRECEDENTS.md #42](../PRECEDENTS.md#custom-lint-enforcement-precedent-42). Use a `.grit` file under this directory + a fixture-file test. The fixture-file test is non-negotiable: it preserves the mutation-self-test property by asserting an exact diagnostic count on a fixture pairing positive cases with negative cases.

**Diagnostic messages name the fix and link the docs.** Every `register_diagnostic` message has two load-bearing pieces: (a) a noun-phrase or action verb-phrase that names what to do to fix the violation (the fix-noun — readers see this and know the next move without leaving the editor); (b) a trailing `See <docs-URL>` pointing at the rule's section in this README so the message stays self-documenting. Process metadata (decision markers like `D19:`, spec-section refs) does NOT belong in the diagnostic — it rots the same way it rots in source comments. The fixture test asserts both pieces are present (substring match for the fix-noun + URL regex) so the convention survives drift.

## Rules

### `microcopy-ellipsis.grit`

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

Test: [`packages/app/tests/integration/microcopy-ellipsis.test.ts`](../packages/app/tests/integration/microcopy-ellipsis.test.ts).

### `no-loosely-typed-webcontents-ipc.grit`

IPC discipline enforcement. Forbids direct electron IPC primitives (`webContents.send`, `ipcMain.handle/on`, `ipcRenderer.invoke/on/once`) outside the typed-wrapper files. Consumers must route through `createInvoker` / `createHandler` / `sendToRenderer` from `packages/desktop/src/shared/ipc-*.ts`. See [PRECEDENTS.md #14](../PRECEDENTS.md) for the IPC discipline rationale.

Test: [`packages/desktop/tests/integration/no-loosely-typed-webcontents-ipc.test.ts`](../packages/desktop/tests/integration/no-loosely-typed-webcontents-ipc.test.ts).

### `no-raw-html-interactive-element.grit`

UI primitives discipline. Forbids raw JSX `<button>`, `<input>`, `<textarea>`, `<select>` inside production `.tsx` under `packages/{app,desktop,plugin}/src/**`. Consumers must use the shadcn primitives (`Button`, `Input`, `Textarea`, `Select`) from `@/components/ui/*`; if the primitive isn't installed yet, add it via `pnpm dlx shadcn@latest add <name>` first. The rule catches the PR #937 failure mode: contributors (including Codex / Claude Code / human reviewers) introducing raw `<button>` JSX while a shadcn `<Button>` from `@/components/ui/button` was already imported in the same file.

**Scoped via `overrides[].plugins`** to `packages/{app,desktop,plugin}/src/**/*.tsx`. Exemptions encoded as negative `!`-globs in the same `includes[]`:

- `!packages/app/src/editor/**` — ProseMirror NodeViews + editor chrome legitimately render raw HTML for measurement / PM-managed DOM. The exemption matches the existing `a11y/useSemanticElements` suppressions scattered through the editor subtree.
- `!packages/app/src/components/ui/**` — these files ARE the shadcn primitive wrappers; they MUST render raw HTML by definition.
- `!**/*.test.tsx` + `!**/*.dom.test.tsx` + `!**/*.test-helper.tsx` — test fixtures and shared test doubles aren't user-facing UI.

**Pre-rule backlog (ratchet pattern).** Files that pre-date the rule and use raw `<button>` / `<input>` / `<textarea>` carry a file-level `// biome-ignore-all lint/plugin/no-raw-html-interactive-element: pre-rule backlog — ...` comment at the top of the file. The comment list across the codebase IS the visible migration backlog — review treats each `biome-ignore-all` header as a backlog marker, not a free pass. Drain by migrating the file to shadcn primitives, then deleting the suppression header (the rule starts firing again immediately, so a partial migration that misses a raw `<button>` fails the gate). Reference migration: `packages/app/src/components/NavigatorApp.tsx` (three raw `<button>` → shadcn `<Button variant="ghost|outline|link">`).

The rule does NOT catch:
- PascalCase composite components whose name starts with `Button` / `Input` (e.g. `<ButtonGroup>`, `<InputGroup>`) — pattern scopes to lowercase JSX tag names only.
- Raw HTML in `.ts` files (e.g. dangerouslySetInnerHTML strings, template literals).
- Raw `<a>` used as an action — anchor-as-button is governed by Biome's built-in `a11y/useSemanticElements` + the codebase's existing button-vs-anchor conventions.
- Other interactive primitives (`<dialog>`, `<details>`, `<summary>`) where the team hasn't yet committed to a shadcn-only contract.

Plugin: [`biome-plugins/no-raw-html-interactive-element.grit`](no-raw-html-interactive-element.grit). Fixture: [`biome-plugins/__fixtures__/no-raw-html-interactive-element.fixture.tsx`](__fixtures__/no-raw-html-interactive-element.fixture.tsx). Test: [`packages/app/tests/lint-plugins/no-raw-html-interactive-element.test.ts`](../packages/app/tests/lint-plugins/no-raw-html-interactive-element.test.ts). See [PRECEDENTS.md #42](../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the GritQL-plugin convention.

### `no-resolved-value-theme-source.grit`

1-way theme contract. Forbids resolving the user-intent theme value at the `bridge.setThemeSource(...)` call site. The contract is 1-way: pass the unresolved CRDT value (`'system' | 'light' | 'dark'`) verbatim. `'system'` delegates appearance tracking to macOS via `nativeTheme`; resolving at the call site (via `matchMedia` or a `prefersDark ? 'dark' : 'light'` ternary) loses tracking. See [PRECEDENTS.md #40(a)](../PRECEDENTS.md) for the renderer-state↔main-state contract.

Detection patterns (call expressions only — type-declarations are naturally excluded):
- `setThemeSource($arg)` where `$arg` contains `matchMedia` (any form)
- `setThemeSource($arg)` where `$arg` contains both `'light'` and `'dark'` string literals (likely a ternary, either order)
- Matches both bare-call and member-call shapes (`obj.setThemeSource(...)`)

Test: [`packages/desktop/tests/integration/no-resolved-value-theme-source.test.ts`](../packages/desktop/tests/integration/no-resolved-value-theme-source.test.ts).

### `no-split-suggestion-dispatch.grit`

One-transaction suggestion insertion ([PRECEDENTS.md #58](../PRECEDENTS.md#one-transaction-menu-insertions-precedent-58)). Inside a `@tiptap/suggestion` `Suggestion({ ... })` config, a trigger-range delete dispatched on its own (separate from the content insert) opens a re-entrant-dispatch window: anything fired synchronously during the delete's own `updateState` (a plugin `appendTransaction`, a view/NodeView update, the y-prosemirror binding reacting to the delete) can remap the selection onto an adjacent `selectable: true` node, and the follow-up insert then silently REPLACES that node. The fix is one chain (`.deleteRange(range).insertContent(...).run()`) or an `applySlashCommandItem`-style boundary (`packages/app/src/editor/slash-command/apply-item.ts`) for items needing post-commit work.

Detection patterns (scoped to `Suggestion($config)` call sites, so delete-only surfaces outside suggestion configs — e.g. a mention chip's remove button — never fire):
- a chain whose `.run()` receiver is the `deleteRange(...)` call itself (`....deleteRange(range).run()` — a compliant atomic chain always continues past the delete before `.run()`)
- `$editor.commands.deleteRange($range)` — the `commands.*` form dispatches immediately, always a standalone delete transaction

**Registered at root `plugins[]`** (workspace-wide, like `microcopy-ellipsis`): the pattern self-scopes to `Suggestion(...)` calls, and a future suggestion surface in any package must be covered without a biome.jsonc edit.

The rule does NOT catch:
- a split whose delete chain carries a non-content step after `deleteRange` and before `.run()` (e.g. `.deleteRange(r).focus().run()`) — the `.run()` receiver is then not the `deleteRange` call
- a second dispatch made inside a delegated item body (`item.command(editor)` running its own `editor.chain().run()`) — lint can't see through delegation
- raw `view.dispatch(tr.delete(...))` inside a Suggestion config — no occurrence today

Runtime complement: `packages/app/src/editor/extensions/suggestion-atomicity.dom.test.tsx` + `slash-command-atomicity.dom.test.tsx` drive every registered suggestion surface through a real Enter and assert exactly one doc-changing transaction — they catch the delegated-dispatch shapes the lint can't.

Plugin: [`biome-plugins/no-split-suggestion-dispatch.grit`](no-split-suggestion-dispatch.grit). Fixture: [`biome-plugins/__fixtures__/no-split-suggestion-dispatch.fixture.tsx`](__fixtures__/no-split-suggestion-dispatch.fixture.tsx). Test: [`packages/app/tests/lint-plugins/no-split-suggestion-dispatch.test.ts`](../packages/app/tests/lint-plugins/no-split-suggestion-dispatch.test.ts).

### `no-unportaled-editor-content.grit`

H6 cross-doc DOM bleed contract. `@tiptap/react`'s `PureEditorContent.componentDidMount` runs `element.append(...editor.view.dom.parentNode.childNodes)` — a sibling-vacuum primitive. When `view.dom` shares a parent with another editor's `view.dom` (e.g., V2 cache parked nodes, cross-Activity reconciliation transitions), the vacuum drags foreign content into the active wrapper. The structural fix is to render every `<EditorContent>` via `React.createPortal` into a per-Activity exclusively-owned DOM target, so `view.dom`'s parent only ever contains THIS editor's nodes.

The rule flags every JSX usage of `<EditorContent>` — both self-closing and child-bearing forms — and asks the author to suppress at the canonical portaled site (where the createPortal call lives) with `// biome-ignore lint/plugin/no-unportaled-editor-content: <reason>`. Adding a non-portaled `<EditorContent>` anywhere else in the codebase becomes a lint error, gated at editor-save / `pnpm lint` time.

Canonical sanctioned shape (TiptapEditor.tsx):

```tsx
createPortal(
  <EditorContent editor={editor} className="..." />,
  portalTarget,
);
```

Plugin: [`biome-plugins/no-unportaled-editor-content.grit`](no-unportaled-editor-content.grit). Fixture: [`biome-plugins/__fixtures__/no-unportaled-editor-content.fixture.tsx`](__fixtures__/no-unportaled-editor-content.fixture.tsx). Test: [`packages/app/tests/integration/no-unportaled-editor-content.test.ts`](../packages/app/tests/integration/no-unportaled-editor-content.test.ts). See [PRECEDENTS.md #44](../PRECEDENTS.md) for the H6 cross-doc DOM bleed contract and [PRECEDENTS.md #42](../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the GritQL-plugin convention.

### `no-uninstall-forbidden-import.grit`

"Connects to nothing" first-hop feedback. The self-uninstall window's survey and completion screens render after `ok uninstall --yes` has stopped the local Hocuspocus server and removed `~/.ok`, so the uninstall entry must never reach the editor, the CRDT stack, the provider pool, or the server bootstrap — and must eager-load (no dynamic `import()`) so those screens paint from memory once teardown is under way.

Scoped via `overrides[].plugins` to `packages/app/src/uninstall/**` (test files exempt — a dom test legitimately does `await import('./main')` to prove the entry paints). Two diagnostics:
- A static import (`import … from`, `import type … from`, `import * as … from`, or side-effect `import`) whose source is an editor / CRDT / provider-pool / Hocuspocus-server specifier (`@/editor/*`, `@inkeep/open-knowledge-server`, `@hocuspocus/*`, `yjs`, `y-protocols`, `y-prosemirror`, `y-codemirror.next`, `y-indexeddb`, `@tiptap/y-tiptap`, `@tiptap/extension-collaboration*`). `@inkeep/open-knowledge-core` (shared types + constants) is deliberately allowed.
- Any dynamic `import()`.

This rule is **shallow, first-hop feedback only**. The authoritative gate is the transitive-module-graph test at [`packages/desktop/tests/unit/uninstall-module-graph.test.ts`](../packages/desktop/tests/unit/uninstall-module-graph.test.ts), which builds the entry alone and checks its whole loaded-module set — so it also catches a forbidden module reached indirectly through a shared `@/lib` / `@/components/ui` module, and re-export (`export … from`) edges GritQL cannot express.

Plugin: [`biome-plugins/no-uninstall-forbidden-import.grit`](no-uninstall-forbidden-import.grit). Fixture: [`biome-plugins/__fixtures__/no-uninstall-forbidden-import.fixture.tsx`](__fixtures__/no-uninstall-forbidden-import.fixture.tsx). Test: [`packages/desktop/tests/integration/no-uninstall-forbidden-import.test.ts`](../packages/desktop/tests/integration/no-uninstall-forbidden-import.test.ts). See [PRECEDENTS.md #42](../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the GritQL-plugin convention.

### `path-conditional-map-driven-origin.grit`

Observer A origin discipline. Inside `packages/server/src/server-observers.ts`, every `Y.Doc.transact()` call MUST pass the sanctioned origin `OBSERVER_SYNC_ORIGIN` as its second argument (`doc.transact(fn, OBSERVER_SYNC_ORIGIN)`). Bare `doc.transact(fn)` - or a wrong origin - routes the write to `openknowledge-service` and breaks per-session UndoManager attribution (the `trackedOrigins` Set-identity match skips the transaction).

**Scoped via `overrides[].plugins`** to `packages/server/src/server-observers.ts`. Other server files routing through `session.dc.document.transact(fn, session.origin)` are out of scope - that contract is enforced by `paired-write-enforcement.test.ts`.

The rule checks the **argument position** (the second argument node), not whether the call subtree contains the identifier somewhere. It matches every `transact(...)` call, then excludes the two sanctioned shapes (`transact($_, OBSERVER_SYNC_ORIGIN)` and the 3-arg `transact($_, OBSERVER_SYNC_ORIGIN, $...)`). A callback body that mentions `OBSERVER_SYNC_ORIGIN` for an unrelated reason therefore neither clears a bare/wrong call nor trips a correct one - the prior `contains`-based shape was falsely cleared by such a mention.

The rule does NOT catch:
- Transact calls outside `server-observers.ts` (scoped to the one observer-dispatch file)
- An origin passed in a position other than the second argument (the contract is second-argument placement; no real call site does otherwise)

Plugin: [`biome-plugins/path-conditional-map-driven-origin.grit`](path-conditional-map-driven-origin.grit). Fixture: [`biome-plugins/__fixtures__/path-conditional-map-driven-origin.fixture.tsx`](__fixtures__/path-conditional-map-driven-origin.fixture.tsx). Test: [`packages/server/src/path-conditional-map-driven-origin.test.ts`](../packages/server/src/path-conditional-map-driven-origin.test.ts).

### `cst-pm-handler-todo-stub.grit`

Codemod handler TODO-stub grep. Flags handler files under `packages/md-conformance/src/substrates/*/handlers/` that still contain the codemod's stub body (`throw new Error("TODO: implement <substrate>:<dir>/<key>")`), so a codemod stub that survives to lint time is caught.

This is a TODO-stub grep, NOT an exhaustiveness check. Whether a substrate covers every PM node type (the node-set traversal over `packages/core/schema-snapshot.json`) is a separate concern owned by a suite-self-consistency gate. The compile-time backstop for missing methods is the TypeScript handlers-table type check against `ICstEngine`.

**Scoped via `overrides[].plugins`** to the per-substrate handlers/ subtrees (see the biome.jsonc override includes). The codemod implementation, harness tests, and oracles are out of scope (they legitimately produce strings containing "TODO: implement" in their own contexts).

The rule does NOT catch:
- Missing handler FILES (file-presence is out of GritQL's scope; TypeScript + codemod coverage handle this)
- Whether the handler set is complete per the PM schema (a separate node-set traversal, deferred to the suite-self-consistency gate)
- Error subclasses (only matches `new Error(...)`)
- Non-anchored "TODO" mentions (regex requires the message to start with `TODO: implement`)

Plugin: [`biome-plugins/cst-pm-handler-todo-stub.grit`](cst-pm-handler-todo-stub.grit). Fixture: [`biome-plugins/__fixtures__/cst-pm-handler-todo-stub.fixture.tsx`](__fixtures__/cst-pm-handler-todo-stub.fixture.tsx). Test: [`packages/md-conformance/src/lint-plugins/cst-pm-handler-todo-stub.test.ts`](../packages/md-conformance/src/lint-plugins/cst-pm-handler-todo-stub.test.ts).

### `class-proof-registration-discipline.grit`

Class-proof DSL contract enforcement. Two patterns (GritQL `or` — short-circuit, Pattern A wins when both apply):

- **Pattern A (missing args):** flags `defineClassProof(name, opts)` when `opts` doesn't contain both `predicate:` and `proof:` property assignments.
- **Pattern B (outside canonical dir):** flags any `defineClassProof(...)` call. The override scope excludes `packages/md-conformance/src/class-proofs/proofs/**`, so this fires only on registrations outside the sanctioned location.

Inside the canonical proofs/ dir, neither pattern fires — TypeScript's `ClassProofOptions<M>` signature backstops the missing-args check, and any `defineClassProof` call there is in the sanctioned location.

**Scoped via `overrides[].plugins`** to all `.ts`/`.tsx` files EXCEPT the canonical `class-proofs/proofs/**` dir and `*.test.ts`/`*.test.tsx` (test files that exercise the DSL are exempt — `dsl.test.ts` legitimately calls `defineClassProof` outside the canonical dir).

The rule does NOT catch:
- Missing-args violations inside the canonical proofs/ dir (TypeScript catches those)
- Functions with similar names (`myDefineClassProofVariant`) — pattern matches the exact function name
- Type references to `defineClassProof` — pattern scopes to call expressions

Plugin: [`biome-plugins/class-proof-registration-discipline.grit`](class-proof-registration-discipline.grit). Fixture: [`biome-plugins/__fixtures__/class-proof-registration-discipline.fixture.tsx`](__fixtures__/class-proof-registration-discipline.fixture.tsx). Test: [`packages/md-conformance/src/lint-plugins/class-proof-registration-discipline.test.ts`](../packages/md-conformance/src/lint-plugins/class-proof-registration-discipline.test.ts).

### `playwright-prefer-to-have-count.grit`

Flags `expect(await locator.count())` — the one-shot count snapshot that never retries. Under CI CPU contention the DOM settles a few frames after the read, so the assertion flakes while the auto-retrying web-first form `await expect(locator).toHaveCount(n)` passes deterministically (the no-retry read was one of the hidden-flake shapes in the 2026-06 e2e CI audit). The pattern matches the probe sub-expression regardless of the matcher that follows (`.toBe`, `.toEqual`, `.toBeGreaterThanOrEqual`, ...). Upstream precedent: eslint-plugin-playwright `prefer-to-have-count`.

**Scoped via `overrides[].plugins`** to `packages/app/tests/{stress,visual,a11y}/**/*.e2e.ts` (the same three dirs `tests/integration/e2e-stop-rules.test.ts` source-scans) + the fixture. Not workspace-wide: outside Playwright specs, `.count()` is usually not a `Locator` and the web-first rewrite does not apply.

The rule does NOT catch:
- `expect.soft(await locator.count())` — different callee node shape; zero occurrences today.
- A count read assigned to a variable and asserted later (`const n = await loc.count(); expect(n).toBe(2)`) — two statements; GritQL cannot correlate them. Add an e2e-stop-rules source-scan rule if the split form ever recurs.
- Biome 2.4 plugin diagnostics are diagnostic-only — the `toHaveCount` rewrite is named in the message but not auto-applied.

Plugin: [`biome-plugins/playwright-prefer-to-have-count.grit`](playwright-prefer-to-have-count.grit). Fixture: [`biome-plugins/__fixtures__/playwright-prefer-to-have-count.fixture.tsx`](__fixtures__/playwright-prefer-to-have-count.fixture.tsx). Test: [`packages/app/tests/lint-plugins/playwright-prefer-to-have-count.test.ts`](../packages/app/tests/lint-plugins/playwright-prefer-to-have-count.test.ts). See [PRECEDENTS.md #42](../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the GritQL-plugin convention.

### `no-roundtrip-identity-oracle.grit`

Forbids the byte-fidelity round-trip oracle in public-mirrored tests. Asserting that re-serializing a freshly-parsed document yields back the *same* input — `serialize(parse(x))` (or the MarkdownManager method form `m.serialize(m.parse(x))`) compared equal to that same `x` via `.toBe` / `.toEqual` / `.toStrictEqual` or `===` — is the engine's byte-identity correctness oracle, exercised by its own fidelity suite. A public test should pin a specific expected output instead; this rule keeps a new public test from reintroducing the general oracle.

**Identity, not contract.** The rule fires only when the parse input and the expected value are the *same expression* — GritQL metavariable reuse (`$x` … `$x`) enforces textual equality. That is what separates the oracle from the assertions that must stay public and green:

- A **contract test** pins a *fixed expected literal* (`expect(serialize(parse('# H'))).toBe('# H\n')`) — the expected differs from the input, so it does not fire.
- The **Bridge-invariant comparator** `normalizeBridge(a) === normalizeBridge(b)` (precedent #38, the documented public contract) contains no `serialize(parse(...))` and is never flagged.
- The **normalizing-construct detector** `serialize(parse(x)) !== x` uses `!==`, a different operator, and is never flagged.

**Scoped via `overrides[].plugins`** to the public-mirrored test surface (`packages/**/*.test.ts`, `*.test.tsx`, `*.e2e.ts`). The internal suites that legitimately own the oracle are excluded as negative globs (see the biome.jsonc override includes); on this surface it is forbidden.

The rule does NOT catch:
- Round-trip identity through a helper (`mdRoundTrip(x)`, `normalize(...)`) or an intermediate variable (`const out = serialize(parse(x)); expect(out).toBe(x)`) — the pattern matches the inline call shape, not helper bodies or cross-statement data flow. Those forms live in the path-excluded fidelity suite, covered by exclusion.
- Equality through matchers other than `toBe` / `toEqual` / `toStrictEqual`, or operators other than `===` (e.g. a custom `assertByteIdentical` helper).
- Any oracle whose two sides are not the same inline expression (e.g. a round-trip compared to a different variable).

Plugin: [`biome-plugins/no-roundtrip-identity-oracle.grit`](no-roundtrip-identity-oracle.grit). Fixture: [`biome-plugins/__fixtures__/no-roundtrip-identity-oracle.fixture.tsx`](__fixtures__/no-roundtrip-identity-oracle.fixture.tsx). Test: [`packages/app/tests/lint-plugins/no-roundtrip-identity-oracle.test.ts`](../packages/app/tests/lint-plugins/no-roundtrip-identity-oracle.test.ts). See [PRECEDENTS.md #42](../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the GritQL-plugin convention and [PRECEDENTS.md #38](../PRECEDENTS.md) for the Bridge-invariant contract.

### `no-inline-tolerance-class.grit`

Forbids a public-mirrored test from writing a bridge normalization-class value inline as a string literal. `BRIDGE_TOLERANCE_CLASSES` (`packages/core/src/bridge/normalize.ts`) is the bridge normalizer's catalog of byte-difference equivalence classes it tolerates. A public test should assert observable `normalizeBridge` equivalence between inputs rather than hard-coding one of those class labels inline — the label is an internal classification detail, and pinning it inline both couples the test to that detail and re-declares the catalog outside the modules that own it. `check-mirror-test-policy` Check B already blocks a public test from *importing* the catalog symbol; this rule closes the complementary gap where a test re-encodes a class value inline (`expect(applied).toBe('jsx-container-boundary-blank')`, an array of class names), past the import check.

**Identity, not substring.** The `or {}` matches a string-literal node whose value *is* exactly a catalog member, so the names that appear legitimately on the public surface as prose are not flagged:

- A class name inside a longer **test-title sentence** (`test('… (block-separator-collapse class)', …)`) — a different node value, so it does not fire.
- A class name embedded in a **docName** with a prefix (`'fr34-doc-start-thematic'`) — likewise a substring, not the whole value.
- A class name in a **comment** — GritQL matches the string-literal node, not trivia.

The match is quote-style independent (a single-quoted pattern matches the double-quoted form Biome emits). The four **universal text-encoding** classes — `bom`, `crlf`, `trailing-whitespace`, `trailing-newline` — are deliberately NOT matched: they are normalizations every text tool performs, not distinctive classes, and the public floor telemetry runtime (`tolerance-telemetry.ts`) surfaces them, so public tests legitimately assert that runtime emits `class: 'crlf'` for a CRLF input. The 12 markdown-fidelity classes plus those 4 universal classes partition the catalog exactly, and the fixture test's drift canary pins that partition — a class added to `BRIDGE_TOLERANCE_CLASSES` reddens until it is classified into one bucket.

**Scoped via `overrides[].plugins`** to the public-mirrored test surface (`packages/**/*.test.ts`, `*.test.tsx`, `*.e2e.ts`), with the catalog-owning internal suites excluded as negative globs (see the biome.jsonc override includes), so the catalog stays usable there but the inline form is forbidden on this surface.

The rule does NOT catch:
- A class name built by concatenation or template interpolation (`'doc-start-' + 'thematic'`) — neither operand is the whole value.
- A class name in a template literal — the pattern matches string-literal nodes, not template content.

Plugin: [`biome-plugins/no-inline-tolerance-class.grit`](no-inline-tolerance-class.grit). Fixture: [`biome-plugins/__fixtures__/no-inline-tolerance-class.fixture.tsx`](__fixtures__/no-inline-tolerance-class.fixture.tsx). Test: [`packages/app/tests/lint-plugins/no-inline-tolerance-class.test.ts`](../packages/app/tests/lint-plugins/no-inline-tolerance-class.test.ts). See [PRECEDENTS.md #42](../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the GritQL-plugin convention.

### `require-windowshide-on-spawn.grit`

Windows console-flash prevention. Every hand-rolled `node:child_process` process-spawn (`spawn` / `spawnSync` / `execSync` / `execFile` / `execFileSync`, plus the repo aliases `nodeSpawn` and `execFileAsync`) must hide the Windows console it would otherwise pop — either by wrapping its options in `withHiddenWindowsConsole(...)` (from `@inkeep/open-knowledge-server`, the preferred form shared with the server package) or by an inline `windowsHide: true`.

**Why.** On Windows, `windowsHide` defaults to `false`. When a console-LESS parent — the OK server auto-started by an MCP host with `stdio: 'ignore'`, or spawned detached — spawns a console-subsystem binary like `git.exe`, Windows creates a new console window that flashes on screen and vanishes, once per spawn. During an editing / agent-write session the per-edit `git` reads produce a steady stream of these. Hiding the console fixes it. The flag is a **no-op on both macOS and Linux** (neither allocates a console for child processes), so it is applied uniformly regardless of the command's target platform.

`simple-git` already sets `windowsHide: true` internally, so git routed through it (shadow repo, share, conflicts) is out of scope by nature — this rule governs only the hand-rolled call sites that bypass it.

**Scoped via `overrides[].plugins`** to `packages/{server,cli}/src/**/*.ts` (the packages that spawn processes at runtime on Windows), with `!**/*.test.ts` + `!**/*.test-helper.ts` excluded. `packages/desktop` is deliberately **out of scope** — the Electron app is macOS-only and never runs on Windows.

**Opting out (macOS/Linux-only spawns).** For a spawn that only ever runs on macOS and/or Linux — `codesign`, `sw_vers`, an `open(1)` launch — hiding a console is meaningless. Either add the flag anyway (a harmless no-op that keeps the rule uniform) or suppress that one call with a reason:

```ts
// biome-ignore lint/plugin/require-windowshide-on-spawn: macOS-only (never spawned on Windows)
const r = spawnSync('codesign', [...], { ... });
```

Reference opt-out in the tree: [`packages/cli/src/commands/diagnose-health-checks/macos-codesig.ts`](../packages/cli/src/commands/diagnose-health-checks/macos-codesig.ts). Same-named wrapper false positives (a local `const spawn = deps.spawnDetached ?? …`, or an injected `spawn` param) use the same suppression with a "not node:child_process" reason.

The rule does NOT catch: bare `exec(...)` (the identifier is too commonly shadowed); member calls (`deps.spawn(...)` — a different AST, so the real impl behind the injection is the enforced site); a `windowsHide` / `withHiddenWindowsConsole` written inside a spawn's callback body (would spuriously satisfy the check — no realistic occurrence).

Plugin: [`biome-plugins/require-windowshide-on-spawn.grit`](require-windowshide-on-spawn.grit). Fixture: [`biome-plugins/__fixtures__/require-windowshide-on-spawn.fixture.tsx`](__fixtures__/require-windowshide-on-spawn.fixture.tsx). Test: [`packages/server/src/lint-plugins/require-windowshide-on-spawn.test.ts`](../packages/server/src/lint-plugins/require-windowshide-on-spawn.test.ts). See [PRECEDENTS.md #42](../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the GritQL-plugin convention.

### `require-utf8-multipart-parser.grit`

Multipart filename charset correctness. `busboy(...)` may only be constructed inside [`packages/server/src/multipart.ts`](../packages/server/src/multipart.ts); every other multipart body is parsed through its `createMultipartParser(req, limits)` factory, which hardcodes `defParamCharset: 'utf8'`.

**Why.** busboy defaults `defParamCharset` to `latin1` — an inheritance from `Content-Disposition`'s original MIME/email definition, not from the `multipart/form-data` rules. RFC 7578 governs this surface instead. It issues no receiver mandate — section 5.1.3 is explicit that a parser cannot assume any particular charset was used — so the default is ours to choose, and UTF-8 is the only defensible choice: section 4.2 records that "the encoding used for the file names is typically UTF-8", and the sender-side form-charset ladder in section 5.1.2 terminates at UTF-8. Browsers and Node/undici both put the name on the wire as raw UTF-8 bytes in the plain `filename=` parameter, so at the default every multi-byte sequence is read back as one mojibake code point per byte: `café.png` arrives as `cafÃ©.png`, `会議メモ.pdf` loses essentially all of its information. The damage lands at the transport-decode boundary, before any sanitizer or storage layer sees it, and it is not invertible there — the mojibake is indistinguishable from a filename the user legitimately owns.

The omission is invisible in review: `busboy({ headers, limits })` reads as complete unless you happen to know the default. It shipped at two construction sites for exactly that reason, the second copied from the first along with its `limits` shape, which is why this is a mechanical gate rather than a review convention.

**Presence match, not absence match.** The sibling `require-windowshide-on-spawn` rule is shaped as "the call must contain `windowsHide`", because there the option's only correct value is `true`. That shape is too weak here: "the call must contain `defParamCharset:`" is satisfied by `defParamCharset: 'latin1'`, which passes lint and reintroduces the bug. The factory takes no charset parameter, so routing through it removes the value hole entirely and reduces this rule to a plain presence check on the constructor. Both the wrong-value and the right-value-wrong-place cases are pinned as must-fire fixtures.

**Registered via `overrides[].plugins`** repo-wide (`**/*.ts`, `**/*.tsx`, `**/*.mts`) rather than per-package: server owns the only busboy dependency today, and that is exactly the state a new dependency elsewhere would change, silently. Excluded are `!packages/server/src/multipart.ts` (the one sanctioned construction site), `!**/*.test.ts`, `!**/*.test.tsx`, and `!**/*.test-helper.ts`. The test exclusion is deliberate rather than copied: [`packages/server/src/http/local-api-dispatch.test.ts`](../packages/server/src/http/local-api-dispatch.test.ts) drives its own parser inside a synthetic `/api/upload-lite` handler that counts bytes and never decodes a non-ASCII name.

**Opting out.** There is no legitimate second construction site. A caller that needs different parser options (`preservePath`, `highWaterMark`, …) should widen the factory — that keeps the charset decision in one place, and forces the path-traversal reasoning `preservePath` demands rather than letting it be set in passing. If you genuinely must construct in place, suppress the one call with a reason:

```ts
// biome-ignore lint/plugin/require-utf8-multipart-parser: <reason>
const bb = busboy({ headers, defParamCharset: 'utf8' });
```

The rule does NOT catch: member calls (`parsers.busboy(...)` — a different AST); a call through a renamed binding (`import bb from 'busboy'; bb(...)`). Both are defeatable on purpose rather than by accident. A `ReturnType<typeof busboy>` type annotation is not a call expression and correctly does not fire; it is pinned as a negative fixture so a future pattern change cannot silently start flagging type positions. The behavioural backstop for all of these is [`packages/app/tests/integration/api-error-envelope/upload-filename-charset.test.ts`](../packages/app/tests/integration/api-error-envelope/upload-filename-charset.test.ts), which asserts the decode end to end over real HTTP through both endpoints.

Plugin: [`biome-plugins/require-utf8-multipart-parser.grit`](require-utf8-multipart-parser.grit). Fixture: [`biome-plugins/__fixtures__/require-utf8-multipart-parser.fixture.tsx`](__fixtures__/require-utf8-multipart-parser.fixture.tsx). Test: [`packages/server/src/lint-plugins/require-utf8-multipart-parser.test.ts`](../packages/server/src/lint-plugins/require-utf8-multipart-parser.test.ts). See [PRECEDENTS.md #42](../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the GritQL-plugin convention.

### `no-blind-agent-host-fanout.grit`

Scope discipline for user-global Agent Skill installs. Bans the `skills` CLI npm specs (`skills@~1.5.0` and its caret / exact / `latest` variants) and the bare `'--agent'` argv token anywhere under `packages/{server,cli}/src/**`.

**Why.** `installUserSkill` used to shell out to `npx -y skills@~1.5.0 add <dir> --agent '*' -g -y --copy`. `--agent '*'` makes that CLI skip its own host detection and target every host in its registry (~75 and growing), so a single `ok init` wrote 110 directories across 54 tool-config homes in a real `$HOME` — 51 of them for tools the reporter had never installed ([issue #820](https://github.com/inkeep/open-knowledge/issues/820)). OK's user-global skills are behavioural instructions autonomous software reads and acts on, so writing one into a tool's config dir is a scope-of-consent decision, not cosmetic clutter.

Nothing about the dependency was load-bearing: OK passed a local path (no source resolution), forced `--copy` (no symlinks), and the CLI writes no lockfile or state at global scope. It contributed a directory table that OK already maintains in core for project scope — while costing a floating-range `npx -y` fetch-and-execute at init time and third-party telemetry OK never opted out of. The install now writes directly, gated on `detectUserSkillHosts`, whose host set derives from `HOSTS_WITH_USER_SKILL_DIR` in [`packages/core/src/constants/editors.ts`](../packages/core/src/constants/editors.ts).

The rule bans the *ingredients* rather than the assembled command line, because the argv was built as an array of literals that no single AST node spans.

**Scoped via `overrides[].plugins`** to `packages/{server,cli}/src/**/*.ts`. Tests are deliberately **in** scope (unlike the sibling spawn rule): a test that reintroduces the invocation reintroduces the fan-out, and the suite asserts the writer's behavior through the filesystem, never through argv.

The rule does NOT catch a spec assembled by concatenation or interpolation (`` `skills@${range}` ``), or the flag reaching a subprocess through a variable — GritQL matches the string-literal node. Both are defeatable-on-purpose rather than accidental; the behavioural backstop is [`packages/server/src/skill-install.test.ts`](../packages/server/src/skill-install.test.ts), whose "never creates a dotdir for a host that is not installed" case asserts the real filesystem outcome.

Adding a host that needs a different install mechanism? Add it to `HOSTS_WITH_USER_SKILL_DIR` and let the detection gate cover it — don't suppress this rule.

Plugin: [`biome-plugins/no-blind-agent-host-fanout.grit`](no-blind-agent-host-fanout.grit). Fixture: [`biome-plugins/__fixtures__/no-blind-agent-host-fanout.fixture.tsx`](__fixtures__/no-blind-agent-host-fanout.fixture.tsx). Test: [`packages/app/tests/lint-plugins/no-blind-agent-host-fanout.test.ts`](../packages/app/tests/lint-plugins/no-blind-agent-host-fanout.test.ts). See [PRECEDENTS.md #42](../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the GritQL-plugin convention.

### `no-unwrapped-user-facing-string.grit`

Localization discipline. Makes a hardcoded user-facing string a **build-visible defect** rather than a convention someone has to remember — the gap that let the app accumulate residual English while the `en` catalog grew past 2,800 entries. Four surfaces:

- **Toast arguments** — `toast.error('…')`, `toast.success('…')`, any `toast.<method>` whose first argument is a string literal.
- **JSX text children** — `<span>No documents match your search</span>`.
- **UI-facing attributes** — `aria-label`, `placeholder`, `title`, `alt` with a string-literal value.
- **UI-facing object properties** — `{ label: 'Delete table' }`, `{ description: 'Link to a page or external URL' }`. Same six names as the attribute branch plus `label` and `description`.

The wrapped forms — `<Trans>…</Trans>`, `` t`…` `` from `useLingui()` / `@lingui/core/macro` — are not literals in the positions above and never fire.

**Why object position needed its own branch.** `{ title: '…' }` renders the same words `title="…"` renders, but the attribute branch cannot see it, and that shape was where the residual English actually was: a sweep found 50 of them (menu items, picker entries, hover-preview panels, user-shown error envelopes) against zero the other three branches could reach. The name scope is what keeps it usable — the same measurement that produced the JSX prose test applies here, since an unscoped literal rule fires on every `className`, `data-testid`, and identifier in the tree. With the six names and the prose test, the branch found **1 hit in `packages/app/src`** after the migration landed, and that one is a deliberate non-copy label carrying a `biome-ignore`.

**Implementation note.** Biome's GritQL exposes no object-member node kind (its JS node vocabulary is `call_expression`, `member_expression`, `jsx_attribute`, … — there is no `pair`), so the branch is written as the code snippet `` `$name: $value` ``. That binds to JS object-literal pairs only: a TypeScript member such as `label: 'left' | 'right'` inside a `type` or `interface` is a different node and is structurally out of reach, which is what keeps string-literal union types from firing.

**Where a `msg` descriptor is the fix instead of `t`.** When the object is module scope — a `const` array of menu items, a severity table, a language list — a `t` call in it resolves once at import and then keeps whatever language was active then, however correctly it is wrapped. `I18nProvider` re-renders context *consumers*, not the whole tree, so nothing corrects it later. Hold a `msg` descriptor in the object and resolve it with `t(descriptor)` at render, in a component that calls `useLingui()`; that hook call is also what subscribes the component to the locale change. `BlockTypeSelector.tsx` and `editor/utils/severity.ts` are the reference shapes.

**The prose test, and why the branches differ.** The two JSX branches require **two letter-words separated by whitespace**; the toast branch takes any literal. That asymmetry is measured, not stylistic: a toast argument is unambiguously user-facing, whereas raw JSX text in this codebase is overwhelmingly *not* prose. Firing on every JSX literal produced 53 hits across the product tree of which **zero** were genuine copy — keyboard-shortcut tokens (`Ctrl+Shift+N`), code identifiers (`open-knowledge`), sample paths (`notes / release-plan.md`), and brand marks (`OpenKnowledge`). With the prose test the same sweep produced **4 hits, all real** (two `aria-label`s and one banner sentence in `ConflictsSection.tsx`, one toast in `FileTree.tsx`), which is the signal-to-noise ratio that makes a lint rule worth obeying. Note the two-word test also excludes tokens joined by punctuation, since `notes / release-plan.md` has no letter–space–letter run.

`<Brand> icon` is exempt in-pattern: it is the accessible name of a third-party mark, and translating it renames the product.

**Scoped via `overrides[].plugins`** to `packages/{app,desktop,plugin}/src/**`, `.ts` as well as `.tsx` — the toast branch's dominant shape is a plain `lib/` helper, not a component. Exemptions as negative `!`-globs: `!packages/app/src/editor/**` (ProseMirror/CodeMirror-managed views, whose placeholder and title strings are editor affordances), `!packages/app/src/components/ui/**` (shadcn primitive wrappers — attribute strings there are prop plumbing), `!packages/desktop/src/main/**` (the Electron main process — see below), and `!**/*.test.ts` / `!**/*.test.tsx` / `!**/*.dom.test.tsx`.

`packages/desktop/src/main/**` is excluded because `lingui extract` reads `packages/app/src` only, so a `t` macro written there reaches no catalog; main's one translated surface, the native menus, goes through `main-i18n.ts`, which looks its labels up by hash against the renderer's compiled catalogs. The object-property branch fires on 20 of main's `dialog.showMessageBox` templates and OTel metric descriptions, and asking for a fix that does not exist is how a rule earns a blanket suppression. Main's four sibling dirs (`preload` / `renderer` / `shared` / `utility`) stay in scope.

The rule does NOT catch:

- **Single-word JSX copy** — `<Button>Save</Button>`. The known cost of the prose test; nothing statically separates `Save` from `Discord`. The backstop is the Simplified-Chinese coverage sweep, where residual English is unmissable against Han script.
- **Object properties outside the six scoped names** — `{ message: 'Server returned…' }`, `{ error: '…' }`, `{ detail: '…' }`. Measured rather than assumed: those three names are dominated by log lines and developer diagnostics (`{ detail: 'copilot is terminal-only; launch via requestTerminalLaunch' }`), so scoping them in would make the rule's first act a demand to translate something no reader ever sees. The user-shown members of that set were wrapped by hand.
- **Module-const strings** — `const TOAST = '…'`. Not a property; a separate shape, and one where a `t` at module scope would be a freeze rather than a fix.
- **A ternary or call in property position** — `{ error: e instanceof Error ? e.message : 'Unknown error' }`. GritQL regexes match the whole node's text, so the value has to *be* a literal; a value that merely *contains* one would also match `{ label: cn('a b') }`.
- **A JSX expression-child string literal** — `<span>{'Loading'}</span>`, or an attribute written `aria-label={'…'}`. The value node opens with `{`, which is what distinguishes a literal from a wrapped macro.
- **Template literals** anywhere, including a toast `description`.
- **The CLI command surface** — `packages/cli/src/**`, deliberately never localized.

Plugin: [`biome-plugins/no-unwrapped-user-facing-string.grit`](no-unwrapped-user-facing-string.grit). Fixture: [`biome-plugins/__fixtures__/no-unwrapped-user-facing-string.fixture.tsx`](__fixtures__/no-unwrapped-user-facing-string.fixture.tsx). Test: [`packages/app/tests/lint-plugins/no-unwrapped-user-facing-string.test.ts`](../packages/app/tests/lint-plugins/no-unwrapped-user-facing-string.test.ts). See [PRECEDENTS.md #42](../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the GritQL-plugin convention.

### `no-physical-direction-utility.grit`

Reading-direction discipline. Chrome layout takes its side from the reading direction, never from a hardcoded left or right, so that adding a right-to-left locale is a catalog change rather than a chrome-wide retrofit. The rule flags physical **margin**, **padding**, and **inset** Tailwind utilities — `ml-`/`mr-`, `pl-`/`pr-`, `left-`/`right-` — and asks for `ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-` instead. In a left-to-right locale the two compile to the same used value, so draining the backlog is a visual no-op today and correct later.

**It matches class strings, not stylesheets.** That is where this codebase's physical properties live: the sweep that produced this rule found 148 of them in `className` values against 31 CSS declarations, and 24 of those 31 style the editor or the rendered document rather than the chrome. One `jsx_attribute` branch covers both spellings, because the bound node is the whole initializer clause — a plain `className="ml-2 flex"` and a multi-line `className={cn('…', cond && 'pr-1.5')}` are the same node to the pattern. The name is matched as `*lassName`, so component APIs that forward a second class string (`containerClassName`, `overflowClassName`) are in scope under their own names.

**Two shapes look physical and are not, and both are measured rather than assumed:**

- **`inset-x-*` is already logical.** Tailwind v4 compiles `inset-x-0` to `inset-inline: 0`. It is absent from the pattern for that reason, not as a carve-out.
- **`left-1/2` is the centering anchor.** It exists to be cancelled by the `-translate-x-1/2` beside it, and at 50% the offset is symmetric, so it centers correctly in both directions; `start-1/2` would flip the anchor while the translate kept pulling the same way. The pattern requires a delimiter after a numeric value, which leaves every fractional inset alone — all 10 `left-1/2` sites in the tree carry that translate.

**Scoped via `overrides[].plugins`** to `packages/{app,desktop,plugin}/src/**/*.tsx`. `.tsx` only: the single branch matches a JSX attribute, so a `.ts` glob would be dead scope rather than extra coverage. Exemptions as negative `!`-globs: `!packages/app/src/editor/**` (ProseMirror and CodeMirror own their DOM and take per-string direction from the text rather than from the chrome), `!packages/app/src/components/ui/**` (shadcn primitives are regenerated by `shadcn add`, so an edit there is overwritten on the next pull), and `!**/*.test.tsx` / `!**/*.dom.test.tsx`.

**Pre-rule backlog (ratchet pattern).** The 81 files that pre-date the rule carry a file-level `// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — …` header, same contract as `no-raw-html-interactive-element`: the comment list across the codebase IS the visible backlog, and review treats each header as a backlog marker rather than a free pass. Drain a file by swapping `ml`/`mr` → `ms`/`me`, `pl`/`pr` → `ps`/`pe`, `left`/`right` → `start`/`end`, then deleting the header — the rule starts firing again immediately, so a partial pass that misses one utility fails the gate. 81 of the 292 chrome files in scope carry a header (148 utilities in total), so the rule is live on the other 211 today.

The rule does NOT catch:

- **Class strings outside a class prop** — `{ containerClassName: 'bottom-3 left-3' }` as an object-literal property, or a module-level `const ROW = 'ml-2 flex'`. Five sites in the tree: four object-literal properties in `GraphLegend.tsx`, one const in `editor-tabs-chrome.ts`. A hand fix, not a rule — the name predicate keys on a JSX attribute, and widening it to every string-valued property is the false-positive surface the negative cases below the fixture's group 6 exist to bound.
- **Fractional insets** — `left-1/3` alongside the `left-1/2` the exclusion is aimed at. One site, and separating them costs more regex than it buys.
- **CSS declarations** — `margin-left:` in `globals.css` (25 sites) or inside a `unsafeCSS` template literal (6, all in the file-tree and skill-cluster shadow styles). A `language css` plugin would reach the stylesheet — verified working in Biome 2.4.15 — but not the template literals, and 24 of the 25 stylesheet sites style the editor or the rendered document, surfaces this rule exempts anyway. One chrome site remains: `.tabs-strip-add`.
- **Physical `border-*`, `rounded-*`, and `text-left`/`text-right`** — real direction hazards, outside this rule's margin/padding/inset scope.

Plugin: [`biome-plugins/no-physical-direction-utility.grit`](no-physical-direction-utility.grit). Fixture: [`biome-plugins/__fixtures__/no-physical-direction-utility.fixture.tsx`](__fixtures__/no-physical-direction-utility.fixture.tsx). Test: [`packages/app/tests/lint-plugins/no-physical-direction-utility.test.ts`](../packages/app/tests/lint-plugins/no-physical-direction-utility.test.ts). See [PRECEDENTS.md #42](../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the GritQL-plugin convention.

## Suppression

Inline `// biome-ignore` comments silence individual diagnostics. The most specific form names the rule and the reason:

```tsx
// biome-ignore lint/plugin/<rule-name>: <reason>
<span>…</span>
```

Empirically verified (matches Biome 2.4 suppression-comment syntax):
- `// biome-ignore lint: reason` (most generic — silences any lint diagnostic)
- `// biome-ignore lint/plugin: reason` (group level)
- `// biome-ignore lint/plugin/<rule-name>: reason` (specific — recommended)
- `// biome-ignore plugin: reason` does NOT work (missing `lint/` prefix)

Current production suppressions:
- `microcopy-ellipsis`: 2 sites (`AuthModal.tsx`, `Breadcrumb.tsx`)
- `no-loosely-typed-webcontents-ipc`: 15 sites (`preload/index.ts` ×12, `shared/ipc-send.ts` ×1, `tests/smoke/theme-sync.e2e.ts` ×2)
- `no-raw-html-interactive-element`: 19 file-level `biome-ignore-all` headers in `packages/app/src/{components,presence}/**` (pre-rule backlog awaiting shadcn migration; see the rule's section above for the ratchet contract)
- `no-resolved-value-theme-source`: 0 sites
- `no-roundtrip-identity-oracle`: 0 sites
- `no-inline-tolerance-class`: 0 sites
- `no-uninstall-forbidden-import`: 0 sites
- `no-unwrapped-user-facing-string`: 1 site — `components/settings/lint-plugin-meta.ts` (`Frontmatter schemas`, the plugin's name beside `markdownlint`; `frontmatter` is a `GLOSSARY.md` never-translate term). Everything else the rule has ever found — the four hits on landing, the 50 the object-property branch was written for — was wrapped rather than suppressed.
- `no-physical-direction-utility`: 81 file-level `biome-ignore-all` headers across `packages/app/src/**` (pre-rule backlog awaiting the logical-property pass; see the rule's section above for the ratchet contract)

**Where an inline `// biome-ignore` can and cannot sit.** A suppression comment needs a line of its own directly above the reported span, which is a property of the *formatting* rather than of the rule. On a JSX attribute that means the attribute must already be on its own line — biome has no slot for a comment between two attributes sharing a line, and reports `Suppression comment has no effect` if you try. A `{/* biome-ignore */}` child covers the element that follows it, not a text node that starts after that element, so JSX-text diagnostics generally need the attribute-style form or a file-level `biome-ignore-all`.

## Adding a new plugin

### 1. Author the `.grit` file

Drop `<rule-name>.grit` in this directory. Each file is one GritQL pattern (or `or { ... }` of patterns):

```gritql
// <rule-name> — <one-line purpose>.
//
// <multi-line rationale>
//
// Suppress legitimate cases with:
//   // biome-ignore lint/plugin/<rule-name>: <reason>

language js

`some-pattern($args)` as $node where {
    register_diagnostic(
        span = $node,
        message = "<problem>. <fix-noun naming the action>. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#<rule-name>grit"
    )
}
```

**Message shape (load-bearing).** The diagnostic message has three parts in order: (1) the problem statement, (2) the fix-noun (the noun-phrase or action verb-phrase the reader applies to make the message go away), (3) `See <docs-URL>` pointing at this README's rule section. Anchor naming follows GitHub's auto-slug for code-fence-stripped headers — `### \`microcopy-ellipsis.grit\`` becomes `#microcopy-ellipsisgrit` (the dot is dropped, the backticks are stripped). Process metadata (decision tokens like `D19:`, spec citations) does NOT belong here — it rots like any other comment-discipline violation.

**Regex matching note:** GritQL regex matches the ENTIRE node text. For substring matches, use `r"(?s).*<term>.*"` — the `.*` wildcards bracket the term, and `(?s)` enables single-line mode so `.` matches newlines (needed for multi-line argument expressions).

### 2. Register in `biome.jsonc`

Pick the scope:

- **Workspace-wide** (default — used by `microcopy-ellipsis`, `no-loosely-typed-webcontents-ipc`, `no-resolved-value-theme-source`): add the path to the top-level `plugins` array. The rule fires on every linted file.
- **Scoped to specific files** (used by `no-raw-html-interactive-element`): add an entry to the `overrides` array with `includes: [...]` listing the in-scope files (and the fixture path so the fixture test still triggers the rule) and `plugins: ['./biome-plugins/<rule-name>.grit']`. Use this when the rule's invariant only holds for a known subset of files — e.g., a rule that should only fire under a specific source subtree. Document the scope-discipline rationale in the rule's docstring and assert it in the fixture-file test.

Either shape participates in the same `biome check` pass; the override form just adds Biome's path matcher in front of the GritQL pattern.

### 3. Author the fixture file

Place at `biome-plugins/__fixtures__/<rule-name>.fixture.tsx`. **Pair positive cases with negative cases** — the negative cases give the `toBe(N)` assertion real teeth. Typical fixture structure:
- 1+ positive case per pattern branch the rule has
- 2-4 negative cases that resemble positive ones but should NOT fire (adjacent methods on the same objects, type declarations, unrelated functions with the same name)

The main `pnpm lint` does NOT reach the `biome-plugins/` directory (lint paths are `packages docs *.json *.jsonc *.ts`), so the deliberately-bad fixture content is invisible to the main lint.

### 4. Author the fixture-file test

Place at `packages/<host>/tests/<scope>/<rule-name>.test.ts` where `<host>` matches the package whose code the rule mainly targets. For `<scope>`: use `lint-plugins/` when `<host>` is `app` (`packages/app/tests/integration/` is in `md-audit`'s `DEFAULT_TEST_GLOBS` and requires `@covers-surface` / `@covers-construct` JSDoc tags scoped to markdown editor surfaces that don't apply to lint-plugin tests), and use `integration/` for all other hosts (`desktop`, `plugin`). Template:

```ts
import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// __dirname → packages/<host>/tests/<scope>/. Repo root is 4 levels up.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/<rule-name>.fixture.tsx';

describe('<rule-name> GritQL plugin', () => {
  test('fires on exactly N positive cases (and on no negative case)', () => {
    const result = spawnSync('pnpm', ['exec', 'biome', 'check', FIXTURE_REL], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const fires = (output.match(/<unique diagnostic-message marker>/g) ?? []).length;
    expect(fires).toBe(N); // exact equality — see "Why toBe(N)?" below
    // Diagnostic message names the fix (action verb-phrase substring).
    expect(output).toContain('<fix-noun>');
    // Diagnostic message appends a docs URL — generic URL regex + anchor
    // substring. The anchor check keeps the regex from being vacuously
    // satisfied by an unrelated URL biome might surface elsewhere.
    expect(output).toMatch(/https?:\/\/[^\s]+/);
    expect(output).toContain('biome-plugins/README.md#<rule-name>grit');
  });

  test('plugin is registered in biome.jsonc', () => {
    const config = require(join(REPO_ROOT, 'biome.jsonc'));
    const plugins = config.plugins ?? [];
    expect(plugins).toContain('./biome-plugins/<rule-name>.grit');
  });
});
```

**Why `toBe(N)` and not `toBeGreaterThanOrEqual(N)`:** exact equality catches drift in BOTH directions. A weakened pattern that no longer fires on a positive case drops the count below N → test fails (the standard mutation-self-test property). A widened pattern that fires on a negative case raises the count above N → test also fails. The latter is the asymmetric-coverage win — pairing positive cases with negative cases gives the `toBe(N)` floor real meaning.

The "plugin is registered" test catches the failure mode where a `.grit` file is added but the `biome.jsonc#plugins` entry is missing.

**For override-scoped plugins** (step 2 second variant): swap the registration assertion for one that asserts the plugin is in `config.overrides[].plugins`, the matching override's `includes` covers every in-scope file (including the fixture), and the plugin is NOT at root `plugins[]` (so an accidental move from override to root, which would over-fire, fails). `no-roundtrip-identity-oracle.test.ts` is the reference shape.

### 5. Verify

```bash
cd public/open-knowledge

# 1. Plugin loads + lint stays clean (after suppression comments at legitimate sites):
pnpm lint

# 2. Fixture test fires the diagnostic on positive cases:
pnpm exec vitest run packages/<host>/tests/integration/<rule-name>.test.ts

# 3. Mutation check (manual, one-time during dev):
#    Temporarily break the .grit pattern; re-run the test; confirm it FAILS;
#    restore the .grit pattern; re-run; confirm it passes.

# 4. False-positive widening check (manual, one-time):
#    Add a positive case to the fixture WITHOUT bumping N in the test.
#    Re-run; confirm it FAILS. This verifies toBe(N) is load-bearing.
```

### 6. Document the rule in this README

Add a section under `## Rules` with: what it flags, what it doesn't catch, links to the plugin + test + relevant precedents.

## Out of scope

- **Autofix.** Biome 2.4's GritQL plugins are diagnostic-only. Plugin diagnostics cannot apply code fixes. If autofix is required, a different enforcement mechanism is needed (build-time codemod, separate `--fix` script).
- **GritQL-internal path filters.** GritQL itself doesn't support file-path allowlists. The natural scope of the GritQL pattern (e.g., JSX-only) is the primary in-pattern mechanism for excluding files; inline `// biome-ignore` comments handle the residual. When a rule needs explicit per-file scoping, register the plugin under Biome's `overrides[].plugins` instead (see `no-raw-html-interactive-element` and step 2 of "Adding a new plugin") — that runs the path matcher at the Biome layer before invoking the GritQL pattern.
- **CLI string content.** `process.stderr.write('...')` / `console.log` template-literal content is not reliably matchable via GritQL call-expression patterns (false-positive rate too high). Review discipline covers these surfaces.

## References

- [Biome Linter Plugins](https://biomejs.dev/linter/plugins/)
- [Biome GritQL Plugin Recipes](https://biomejs.dev/recipes/gritql-plugins/)
- [GritQL Patterns reference](https://docs.grit.io/language/patterns)
- [PRECEDENTS.md #42](../PRECEDENTS.md#custom-lint-enforcement-precedent-42) — the architectural decision codifying this convention.
- [PRECEDENTS.md #14](../PRECEDENTS.md) — IPC discipline (enforced by `no-loosely-typed-webcontents-ipc.grit`).
- [PRECEDENTS.md #40(a)](../PRECEDENTS.md) — renderer-state↔main-state propagation (enforced by `no-resolved-value-theme-source.grit`).
