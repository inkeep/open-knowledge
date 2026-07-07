# Biome GritQL plugins

Custom lint rules for this workspace, registered in [`biome.jsonc`](../biome.jsonc) at the top-level `plugins` array (workspace-wide) OR a scoped `overrides[].plugins` entry (file-specific — used when the rule's invariant only applies to a known subset of files). Each `.grit` file is a single GritQL pattern (or `or { ... }` of patterns) emitting diagnostics via `register_diagnostic()`.

Plugins surface as lint errors during `biome check` (i.e. `bun run lint` and `bun run check`) and as inline editor squiggles via the Biome LSP.

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

UI primitives discipline. Forbids raw JSX `<button>`, `<input>`, `<textarea>`, `<select>` inside production `.tsx` under `packages/{app,desktop,plugin}/src/**`. Consumers must use the shadcn primitives (`Button`, `Input`, `Textarea`, `Select`) from `@/components/ui/*`; if the primitive isn't installed yet, add it via `bunx --bun shadcn@latest add <name>` first. The rule catches the PR #937 failure mode: contributors (including Codex / Claude Code / human reviewers) introducing raw `<button>` JSX while a shadcn `<Button>` from `@/components/ui/button` was already imported in the same file.

**Scoped via `overrides[].plugins`** to `packages/{app,desktop,plugin}/src/**/*.tsx`. Exemptions encoded as negative `!`-globs in the same `includes[]`:

- `!packages/app/src/editor/**` — ProseMirror NodeViews + editor chrome legitimately render raw HTML for measurement / PM-managed DOM. The exemption matches the existing `a11y/useSemanticElements` suppressions scattered through the editor subtree.
- `!packages/app/src/components/ui/**` — these files ARE the shadcn primitive wrappers; they MUST render raw HTML by definition.
- `!**/*.test.tsx` + `!**/*.dom.test.tsx` — test fixtures aren't user-facing UI.

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

### `no-unportaled-editor-content.grit`

H6 cross-doc DOM bleed contract. `@tiptap/react`'s `PureEditorContent.componentDidMount` runs `element.append(...editor.view.dom.parentNode.childNodes)` — a sibling-vacuum primitive. When `view.dom` shares a parent with another editor's `view.dom` (e.g., V2 cache parked nodes, cross-Activity reconciliation transitions), the vacuum drags foreign content into the active wrapper. The structural fix is to render every `<EditorContent>` via `React.createPortal` into a per-Activity exclusively-owned DOM target, so `view.dom`'s parent only ever contains THIS editor's nodes.

The rule flags every JSX usage of `<EditorContent>` — both self-closing and child-bearing forms — and asks the author to suppress at the canonical portaled site (where the createPortal call lives) with `// biome-ignore lint/plugin/no-unportaled-editor-content: <reason>`. Adding a non-portaled `<EditorContent>` anywhere else in the codebase becomes a lint error, gated at editor-save / `bun run lint` time.

Canonical sanctioned shape (TiptapEditor.tsx):

```tsx
createPortal(
  <EditorContent editor={editor} className="..." />,
  portalTarget,
);
```

Plugin: [`biome-plugins/no-unportaled-editor-content.grit`](no-unportaled-editor-content.grit). Fixture: [`biome-plugins/__fixtures__/no-unportaled-editor-content.fixture.tsx`](__fixtures__/no-unportaled-editor-content.fixture.tsx). Test: [`packages/app/tests/integration/no-unportaled-editor-content.test.ts`](../packages/app/tests/integration/no-unportaled-editor-content.test.ts). See [PRECEDENTS.md #44](../PRECEDENTS.md) for the H6 cross-doc DOM bleed contract and [PRECEDENTS.md #42](../PRECEDENTS.md#custom-lint-enforcement-precedent-42) for the GritQL-plugin convention.

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
- `no-raw-html-interactive-element`: 20 file-level `biome-ignore-all` headers in `packages/app/src/{components,presence}/**` (pre-rule backlog awaiting shadcn migration; see the rule's section above for the ratchet contract)
- `no-resolved-value-theme-source`: 0 sites
- `no-roundtrip-identity-oracle`: 0 sites
- `no-inline-tolerance-class`: 0 sites

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

The main `bun run lint` does NOT reach the `biome-plugins/` directory (lint paths are `packages docs *.json *.jsonc *.ts`), so the deliberately-bad fixture content is invisible to the main lint.

### 4. Author the fixture-file test

Place at `packages/<host>/tests/<scope>/<rule-name>.test.ts` where `<host>` matches the package whose code the rule mainly targets. For `<scope>`: use `lint-plugins/` when `<host>` is `app` (`packages/app/tests/integration/` is in `md-audit`'s `DEFAULT_TEST_GLOBS` and requires `@covers-surface` / `@covers-construct` JSDoc tags scoped to markdown editor surfaces that don't apply to lint-plugin tests), and use `integration/` for all other hosts (`desktop`, `plugin`). Template:

```ts
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// __dirname → packages/<host>/tests/<scope>/. Repo root is 4 levels up.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_REL = 'biome-plugins/__fixtures__/<rule-name>.fixture.tsx';

describe('<rule-name> GritQL plugin', () => {
  test('fires on exactly N positive cases (and on no negative case)', () => {
    const result = spawnSync('bunx', ['biome', 'check', FIXTURE_REL], {
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
bun run lint

# 2. Fixture test fires the diagnostic on positive cases:
bun test packages/<host>/tests/integration/<rule-name>.test.ts

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
