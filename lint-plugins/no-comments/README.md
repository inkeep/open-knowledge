# `no-comments`

Open Knowledge writes **no code comments by default**. A comment is legal only when a tool
parses it, or when it carries a contract that code cannot express. Everything else belongs in
the commit message, the PR body, `AGENTS.md`, a spec, or a `README`.

This directory is the single source of truth for that rule. It is a zero-dependency plain-ESM
module so that every consumer runs the *same* predicate:

| Consumer | Lane | Why it exists |
|---|---|---|
| `oxlint` JS-plugin rule | `pnpm lint`, pre-push, CI, editor squiggles | blocking feedback where you already read diagnostics; the JS families only, since oxlint parses no hash grammar |
| backstop sweep (`scripts/no-comments-sweep.mjs`) | `pnpm lint`, `pnpm check`, `lint-staged` | suppression-blind and oxlint-version-independent — a rule disable, a plugin-host regression, or a distribution that drops JS plugins cannot leave the declared scope unguarded |
| comment codemod | one-shot cleanup + rebase recipe | gate and codemod agree by construction, not by transcription |
| `PreToolUse` hook | write time | denies the comment before it is ever written |

No off-the-shelf multi-language comment-*allowlist* linter was found when this was built, which
is why it exists rather than being configured. The nearest single-language artifact is
`eslint-plugin-no-comments`, a prefix-match allowlist; the nearest cross-language tool is
`uncomment`, a tree-sitter deleter. The difference is the rule set: `uncomment` preserves
TODO/FIXME and doc comments by default, a permissive blanket keyed on comment shape, where this
registry admits a comment only when a tool this repository actually runs parses it.

## Running the rule

`pnpm lint` runs `oxlint --max-warnings 0 .`, which loads this plugin from the `jsPlugins`
entry in `oxlint.config.ts`. Loading it is free: the whole-tree run takes the same 6.3s with the
entry as without it. Enforcing costs whatever rendering the findings costs, so the only figure
measured so far is a ceiling — on the *uncleaned* tree the run emits 158,601 diagnostics and
takes 15-20s depending on machine load. The steady state after the cleanup is the loaded-but-
quiet number, not that one.

The editor tier comes with the same install: oxc's editor extensions spawn `oxlint --lsp` from
the project's own `node_modules`, so the language server runs this repo's pinned oxlint and
loads this plugin with it. Verified by driving the server over stdio — opening an in-scope file
publishes this rule's diagnostics as `no-comments(no-comments)`, each carrying the class, the
fix, and the docs anchor, at the lines the CLI reports. Opening a fixture publishes nothing,
because the fixture corpus sits outside the declared scope on purpose.

Two limits are worth knowing before relying on this lane alone:

- JS plugins are alpha upstream and still moving.
- oxc's pure-Rust *standalone* binary accepts a config naming a `jsPlugins` entry, drops the
  plugin, and exits 0 with no warning (oxc-project/oxc#25203). Nothing here runs that binary —
  `pnpm lint` and the editor both use the npm package — but the failure mode is silent where it
  does bite.

The backstop sweep exists for exactly that class of hole: it re-runs this module over the same
scope with no linter involved, so a rule disable, an alpha regression, or a distribution that
quietly drops JS plugins cannot leave the repo unguarded.

## Running the sweep

`pnpm lint` runs the sweep as its `lint:no-comments` step, and `pnpm check` runs it again as
`scripts/no-comments-sweep.test.mjs`, which the Vitest script project picks up by glob.
`node scripts/no-comments-sweep.mjs` runs the same pass by hand and prints a per-unit report —
files, comment lines, violations — which is where the cleanup's before-and-after numbers come
from; `--all` lists every violation rather than the first 25.

Two flags aim it somewhere else. `--root <dir>` sweeps another tree, judged by that tree's own
config, which is how an adopter runs this predicate without vendoring it. `--file <path>` judges
only the paths it names and skips discovery, so the per-unit non-vacuity floor does not apply and
a path no unit claims exits 0 with an `out-of-scope:` line rather than a silent pass. The monorepo root's
`lint-staged` block uses both in a single extension-free route, `public/open-knowledge/**`, so the
config alone decides membership and the glob cannot drift from it. That block is this repository's;
the public tree's own root block carries no such route. Every staged path reaches the
sweep; one no unit claims prints `out-of-scope: <path> (no unit claims it; nothing was read)` and
exits 0. That is how shell gets judged at commit, since the oxc language server hosts no shell
grammar — and it puts a suppression-blind second read on the JS families too.

`--help` prints the accepted grammar and exits 0; any other token the parser does not claim is
refused rather than dropped. The three exit codes are the same contract the codemod's are, so one
caller can branch on both:

| code | meaning |
| --- | --- |
| 0 | the sweep ran and found no violation. In `--file` mode a path no unit claims lands here too, named on an `out-of-scope:` line |
| 1 | the corpus is dirty: a violation was reported, or a declared unit that the config requires to be non-empty discovered no file. `--all` lists every violation rather than the first 25 |
| 2 | the invocation was refused before any work: an unrecognized or repeated argument, a value-taking flag with no path, a `--file` outside `--root`, a scope config that does not load, or a precedent registry that does not load, printed as `precedent-registry: UNREADABLE` with the manifest key or the PRECEDENTS.md numbering problem behind it. Same meaning as the codemod's 2 |

`scripts/no-comments-sweep.mjs` is upstream-only: `scripts/` is enumerated in the mirror manifest
rather than globbed, and the sweep is not one of the entries, so it does not ship to the public
repository; the public tree keeps the oxlint rule. The mirror strips both the
`lint:no-comments` entry and its composite from the exported `package.json`, since a mirrored
script naming an unmirrored file is the PR #599 bug class.

Both lanes enforce at `error` severity over a corpus at zero violations, and a test pins them
to the same value so neither can be turned off without the other.

## The write-time hook

A `PreToolUse` hook on `Edit`/`Write` (`.claude/hooks/no-comments-guard.sh`, evaluating through
`scripts/no-comments-hook.mjs`) applies the pending edit in memory and denies it when the result
carries a comment this predicate rejects. It is diff-scoped: it compares the comments before and
after the edit and reports only what the edit adds, so an edit to a file that still holds
uncleaned stock is never blocked by comments it did not write.

`ALLOW_OK_COMMENT_EDIT=<repo-relative-path>` waves one edit through, and only for the paths it
names (comma-separate several). The bare `=1` form is retired: a wholesale valve silenced the
lane for every path at once, which is exactly when it should still be speaking. The hook fails open — for instance no `jq`,
no `node`, no evaluator, or a payload its own `jq` probe cannot read means it exits silently — because `pnpm lint` and
`pnpm check` are the blocking floors and this lane only moves the feedback earlier. It also exits silently on any
GitHub Actions runner (`GITHUB_ACTIONS` set to a non-empty value), for a different reason: the evaluator is
discovered by walking up from the edited file, so on a runner that tree is a PR checkout and the hook would execute
PR-authored node inside a session that holds a review token. In
this monorepo, harnesses that do not run hooks are covered at
commit by the staged sweep: the extension-free `public/open-knowledge/**` route in the monorepo
root's `lint-staged` block sends every staged in-scope path through it, whatever its family, and a
suppression cannot silence it; the staged `oxlint` pass adds the rule's own diagnostics on top, for
the `{ts,tsx,mjs}` paths it names. In the public repository none of that lane exists, and no other
commit-time lane replaces it: the mirror ships the rule but not the sweep, the codemod or the hook,
and it ships no `.husky/` directory either, so `prepare` returns without installing a git hook and
the `lint-staged` block the mirrored `package.json` still carries is never invoked. There the rule
is reached by running `pnpm run lint` — or `pnpm run check`, which begins with it — and by the
monorepo-side gate a bridged pull request reaches.

Where the hook fails open for a reason the author can act on — for instance a scope config it
cannot read, a valve that suppressed a deny, or an evaluator that threw or crashed — it
says so through `hookSpecificOutput.additionalContext`, the
one `PreToolUse` field the host hands to the agent alongside the tool result. It emits no
`permissionDecision` on those paths, so the edit still meets the host's ordinary permission
evaluation rather than being waved past it; only a deny carries a decision. The same broken
config is a hard failure in `pnpm lint`, the sweep and the codemod, each naming the config file
and the key.

Like the sweep, the hook lives outside the mirrored tree, so it is upstream-only.

## Allowlist

### Tool-parsed directives

`@ts-expect-error <reason>` is judged ahead of the registry because its reason is mandatory: a bare
one is `unreasoned-directive` rather than a directive. Every other admitted shape is a row below.

| id | admitted shape | where the shape has to sit |
|---|---|---|
| `biome-ignore` | `biome-ignore {rule}: {reason}` | first body line |
| `oxlint-disable` | `oxlint-disable` · `oxlint-enable` · `oxlint-disable-next-line` · `oxlint-disable-line` | first body line |
| `eslint-disable` | `eslint-disable` · `eslint-enable` · `eslint-disable-next-line` · `eslint-disable-line` | first body line |
| `vite-ignore` | `@vite-ignore` | first body line |
| `triple-slash-reference` | `/// <reference types="x" />` | anywhere in the body |
| `vitest-environment` | `@vitest-environment {env}` | first body line |
| `ts-nocheck` | `@ts-nocheck` | first body line |
| `ts-check` | `@ts-check` | first body line |
| `license-header` | `SPDX-License-Identifier: {expression}` · `@license {terms}` | the opening lines |
| `legal-comment` | `//! {banner}` · `/*! {banner} */` | the delimiter itself |
| `pure-annotation` | `@__PURE__` · `#__PURE__` | first body line |
| `no-side-effects-annotation` | `@__NO_SIDE_EFFECTS__` · `#__NO_SIDE_EFFECTS__` | first body line |
| `preserve` | `@preserve` | first body line |
| `jsx-pragma` | `@jsxRuntime {runtime}` · `@jsxImportSource {source}` | first body line |
| `bundler-ignore` | `webpackIgnore: true` · `turbopackIgnore: true` · `turbopackOptional: true` | first body line |
| `coverage-ignore` | `v8 ignore {what}` · `c8 ignore {what}` · `istanbul ignore {what}` | first body line |
| `knip-lintignore` | `/** @lintignore {reason} */` | first body line, block form only |

That table is not a summary of the code, it is compared to it: a drift test reads these rows and
`DIRECTIVE_PATTERNS` in `allowlist.mjs` and fails when either carries an id or a shape the other does
not. Documenting a shape here does not admit it, and admitting one there without a row reds.

`knip-lintignore` is block-form only because knip reads it that way: `knip.config.ts` declares
`tags: ['-lintignore']` and knip parses JSDoc, so a `// @lintignore` line comment is not
machine-consumed and stays banned.

The build annotations are read by the bundlers this repo actually ships through: rolldown — the
engine under `tsdown`, which builds `core`, `server`, and `cli` — declares `@__PURE__`,
`@__NO_SIDE_EFFECTS__`, and `@vite-ignore` as one `comments.annotation` class, and `@license`,
`@preserve`, `//!` and `/*!` as one `comments.legal` class. Both options are the repo-side
revocation knob the governability test asks for. Deleting one is the silent-green failure this
allowlist exists to prevent: bundle output changes while typecheck, lint, and tests all stay
green. The JSX pragmas are TypeScript's own per-file `commentPragmas`. The bundler ignore keys are
Turbopack's, measured on the version `docs` builds with: it rejects an unknown key and a wrong
value alike, so `webpackIgnore: false` is prose and `webpackIgnore: true` is not.

The legal-comment openers are the one class the gate cannot bound, and the reason is the consumer:
rolldown preserves a comment because of the bang in its delimiter, whatever follows it. An essay
behind `//!` therefore survives the gate, and it is a gaming finding at review rather than a
gate failure — the same disposition every marker-as-license shape gets.

Directives must **begin** the comment, exactly as the tool that reads them requires. Prose that
merely mentions a directive (`// we should biome-ignore this later`) is prose. Shapes whose
grammar takes exactly one argument are anchored on both ends, so
`// @jsxImportSource is what the app config already sets` is prose while
`/** @jsxImportSource preact */` is a directive.

"Begin the comment" means the directive is the comment's first non-blank body line, not merely a
line somewhere inside it. A block comment that opens with a sentence and reaches its directive
three lines down is an essay wearing a directive, and it is prose: the directive still reaches its
tool, but the paragraph in front of it is exactly what this ban exists to delete. `@lintignore` is
the one shape whose grammar forces a wrinkle here, since knip reads JSDoc blocks and not line
comments: it is admitted only when the comment is block-form AND the tag is its headline, which is
what the `block-headline` target in `DIRECTIVE_PATTERNS` means. Write
`/** @lintignore <reason> */` and put the description in the type's name or the commit message.

A comment is code when three things hold: (1) a tool THIS REPO RUNS parses it; (2) the behavior
it buys is one the repo wants and can govern — a suppression the repo's own config cannot revoke
is not governable, which is why knip's built-in `@public`/`@beta`/`@alias` are deliberately
excluded (they silence knip unconditionally and carry no reason; `@lintignore <reason>` is the
single sanctioned knip channel, revocable in `knip.config.ts`); and (3) it carries its reason
wherever the tool's grammar has room for one, as `@ts-expect-error <reason>`,
`biome-ignore <rule>: <reason>`, and `@lintignore <reason>` already do. A shape that satisfies
all three is added to `DIRECTIVE_PATTERNS` in `allowlist.mjs`, not argued about.

Shapes that look like directives and are **excluded**. `/* eslint-env … */` and `/* globals … */`
fail part (1): no ESLint is installed here, and oxlint 1.66 emits the identical `no-undef`
diagnostics whether or not the pragmas are present, so they buy nothing — its governable channel is
the `env` / `globals` block in `.oxlintrc`, not a comment. `// #region` / `// #endregion` fails part
(1) too: an editor folding marker, read by no tool this repo runs, and the section-divider shape the
ban exists to kill. `//# sourceMappingURL=` / `//# sourceURL=` fail part (2): a bundler writes them
into `dist/`, which this scope excludes, so no authored file in scope carries one and the class only
ever admitted hand-written prose that happened to look like a pragma. `prettier-ignore` fails part
(1): no workspace declares Prettier, and Biome reformats straight through the directive. The
classic-runtime `@jsx` and `@jsxFrag` fail the reachability axis: every tsconfig here compiles with
the automatic runtime, under which a factory pragma cannot apply. The eight non-`Ignore` webpack
keys fail part (1): no workspace declares webpack, and Turbopack rejects them. `node-coverage ignore`
was never a grammar at all — Node's own form is `node:coverage disable` — so it named no tool.

### The two-axis admission table

The three-part test above is enforced, not merely stated. Every entry in `DIRECTIVE_PATTERNS`
carries its consumer as structured data, and `directive-consumers.test.mjs` resolves that claim
against declarations already committed to this repository — never against `node_modules`, because
resolution leaks across sibling worktrees and because an installed transitive is not a declared
dependency. Four claim kinds cover the table:

| kind | the bar it has to clear |
|---|---|
| `declared` | some workspace manifest declares the package, and a manifest that declares it runs the named script |
| `transitive` | the carrier is declared and invoked, and the committed lockfile's `snapshots:` resolves the package under it |
| `latent` | every named package is **absent**; the row carries what would activate it |
| `external` | the consumer is outside this repo entirely, and the row records what it was admitted on |

The latent bar is deliberately inverted. There is no consumer to reach, so the row asserts absence:
wiring the tool in reddens the test and forces the row to be promoted to a claim someone recorded a
reason for, rather than letting it become quietly true for a reason nobody wrote down.

The second axis is reachability, and it is recorded per entry rather than derived, because two
entries are kept in spite of it. `@ts-check` has a present consumer and no reach: no tsconfig sets
`checkJs`, and it is admitted as the sibling of the live `@ts-nocheck`. `/// <reference …>` has a
present consumer and a reach failure that is an encoded judgment about where the shape occurs, not a
derived fact, so it stays. Both verdicts have a test behind them: a tsconfig that switches on
`checkJs`, or one that goes back to the classic JSX runtime, reddens the table and names the row to
revisit.

`@ts-ignore` is **banned** — it silently outlives the error it suppresses. Use
`@ts-expect-error <reason>`.

### Which directives a file class admits

A directive is licensed by the tool that parses it, and which tools reach a file is a property of
that file's grammar and its role, not of the repository as a whole. So the registry is keyed twice —
by grammar family, and by the file class within it — and every declared pair answers for itself:

| grammar family | file class | the shapes it admits |
|---|---|---|
| `c-family` | `typescript` | the directive registry above |
| `c-family` | `esm-script` | the directive registry above |
| `hash-family` | `shell` | none |
| `hash-family` | `yaml` | none |
| `hash-family` | `python` | none |

An undeclared pair is refused by name rather than defaulted, because a file class with no answer is
a question nobody asked yet, and silently handing it the JavaScript registry would admit `@ts-nocheck`
in a shell script.

The three empty rows are the two-axis table applied per family, not an oversight. `# shellcheck` is
the shape to reason about: it is a real directive with a real consumer, and nothing in this
repository runs ShellCheck, so here it is prose and the cleanup deleted every one of them. Wire
ShellCheck in and the row earns a shape through the same table every other row passed. A repository
that already runs it starts with that row filled — the registry is data, and the file class is the
level the data belongs at, since the same `# shellcheck` line inside a workflow's `run:` block is
read by actionlint while the one in a `.sh` file here is read by nobody.

### Sanctioned audit tags

A JSDoc block carrying one of the repo's sanctioned audit tags survives whole, **but only in a
file the framework that reads the tag actually scans**. The vocabulary is whatever
`SANCTIONED_TAGS` holds in `allowlist.mjs`; the paths are `no-comments.tag-globs.generated.json`
at the repo root, which lists one entry per consumer surface (its globs and the tags that surface
reads). Both are pinned against the owning framework by drift tests, and the artifact is
regenerated with `pnpm run generate:tag-globs`, which is upstream-only.

The artifact is a per-repo registry, so it is deliberately absent from the public mirror: the
public vocabulary is empty by construction, and a surface list naming private paths would put
them on a public surface. A repo that ships no such framework has an empty vocabulary, an absent
artifact, or both, and then this class admits nothing — do not assume a tag-bearing JSDoc is
allowed without checking where the file sits.

### `jsdoc-type` (the `esm-script` family only)

A JSDoc block whose every line is a bare type annotation (`@type {…}`, `@param {…} x`,
`@returns {…}`, `@typedef`, `@template`, `@satisfies`, `@import {…} from '…'`) is admitted in
the JavaScript strata, where it is the only typing mechanism the language has. The class is
gated on the file class rather than on a hard-coded extension list, so it follows whatever
`esm-script` declares in `no-comments.config.jsonc` — `.mjs` and `.js` here. Two hard edges:
a description after the identifier makes the block prose (the `{type}` is the machine payload;
the sentence after it is exactly what the ban exists to kill), and the same block in a `.ts`
file is prose, because TypeScript has real syntax there.

### `@deprecated`

A JSDoc `@deprecated` block survives; it is read by editors and by consumers. The tag must open
its own line — the same anchoring the sanctioned audit tags get. Prose that merely names it is
prose, in all three laundering shapes `must-fire.fixture.ts` pins: appended to a sentence,
inlined in a narrating block, and backticked as the subject of a discussion.

### Contract markers

A comment may begin with one of three markers:

- `STOP: <contract>` — an in-repo cross-file contract a reader must not break.
- `WARN: <drift warning>` — a sibling that silently drifts if this changes.
- `UPSTREAM(<referent>): <constraint>` — a code shape forced from **outside** the repo.

`UPSTREAM` referents are shape-validated against a registry of their own:

| id | referent form |
|---|---|
| `github-issue` | `owner/repo#N`, or a `github.com` issue or pull URL normalized to it |
| `rfc` | `RFC <n>`, optionally with a section |
| `commonmark` | `CommonMark §<n>` |
| `package-version` | `pkg@<version>`, checked against the version this repo declares |

Normalizing the URL form means the referent a browser hands you is accepted without rewriting. Several referents may be
listed comma-separated when one constraint genuinely has two sources; each part is validated on its
own and one unresolvable part rejects the marker, naming that part rather than the whole list. Prose
about the referents still belongs in the marker body. The legitimacy line: the constraint's origin must be outside the repo — we
patch a dependency, work around its bug, conform to its spec, or absorb a platform quirk.
A surprise in *our own* code never earns a comment; reshape the code instead. Restating a
dependency's own documentation dies. Our bug in third-party costume dies.

### Validated precedent citations

A comment containing `precedent #N` survives when `N` is a slot some entry in `PRECEDENTS.md`
actually writes, and that entry is not retracted. Numbers come from the entries themselves — a
list ordinal, or the section heading where the section body *is* the entry (`#53` is the only
one of those today). Section headings are read too, but only to cross-check: a slot a heading
claims and no entry writes, an entry no heading claims, and a number written twice are all
parse errors, because each is half of an accidental renumbering. Retracted slots (`#12`, `#29`,
`#52`) keep their numbers so the citations already in the tree still resolve, but a *new*
citation of one is a violation — see `retracted-precedent` below.

A citation licenses the reference, not the essay around it, so the class is capped: more than
`CITATION_LINE_CAP` non-blank body lines and the comment is over it. Three lines at the repository's
100-column width is about 280 characters, which holds a citing sentence and refuses a chapter. The
cap is a cleanup-lane rule rather than a lint diagnostic — the codemod refuses an over-cap site,
leaves its bytes untouched, and writes one record per site to a proposals channel of its own
(`--proposals <path>`), never into the deletion manifest and never back into the file. Where the
citing sentences already fit, the record carries a candidate built from those sentences alone and
machine-checked three ways: it still classifies `precedent-citation`, it cites the same number set,
and it sits inside the cap. Where they do not fit, or the comment shares its line with code, or the
trimmed form would carry rot, the record is marked needs-judgment and carries no machine-authored
prose. Applying a candidate and authoring the rest are an agent's job; the codemod has no
comment-rewriting write mode, because the kept-comment survival net looks for a comment's bytes and
a rewritten comment is not the bytes it kept.

The registry itself is not part of the public mirror; the `PRECEDENTS.md` at the public root is a
generated index of titles that no lane validates against. Validation runs from
`precedent-numbers.generated.json`, an object manifest carrying a schema major and one record
per slot (number, entry form, retracted flag), regenerated upstream by
`pnpm run generate:precedent-numbers` - its generator is not mirrored - and pinned fresh by a
drift test. Every lane reads that
manifest — the in-tree lanes too, because the hook pays for `PRECEDENTS.md` on every keystroke
and the drift test is what keeps the cheaper read honest. A manifest whose schema major this
predicate does not know is named and refused, never silently coerced, so an older mirrored
predicate meeting a newer manifest fails loud instead of admitting everything.

The manifest describes the tree it ships in, so it only stands in for that tree's
`PRECEDENTS.md`. Point the predicate at a different repository that has no `PRECEDENTS.md`
of its own and citations there are admitted unvalidated instead of being checked against
these numbers - a foreign `precedent #104` is not a fabrication, and Open Knowledge's
numbering has no authority over it.

### Guard-defined metacomment markers

Machine-consumed escape channels owned by a specific guard:

| id | what reads it |
|---|---|
| `precedent-30-exemption` | the Precedent #30 static invariant, which strips the block a marked comment introduces before scanning for forbidden shapes |
| `error-log-shape-ok` | the error-log discipline guard, which skips a marked log call |
| `presence-exempt` | the agent-presence structural guard, which subtracts marked sites from its expected count |
| `defect-class` | the lume rot-tier guard, which pairs each rostered runner with the class of rot it catches by reading the slug out of that runner's own header |
| `tolerated-call-site` | the lume call-site polarity and failure-propagation guards, which read it as the written-down opt-out for a remote command whose status is deliberately discarded |

Registering an id in `GUARD_MARKERS` is what makes a marker legal; an unregistered one is prose.
Registration alone is not enough to keep it honest, so a companion test resolves each id to the guard
that reads it and to the paths that guard scans, then fails on any marker sitting outside them — a
copy pasted where no guard looks is prose wearing a marker, which is how this class gets gamed.

### Markers that lead a comment are read only where a comment leads

A guard marker and a licence header are the two classes whose token may legitimately sit below the
first body line: a licence banner runs product line, copyright line, then `@license`, and a guard
marker is often the second half of a short note. Matching them anywhere in the body is what let a
twenty-six line essay survive on one marker buried two thirds of the way down — the marker as a
license, which is the shape the anti-gaming rule calls high severity.

So both classes read only the comment's **opening lines**: the first `OPENING_LINE_WINDOW` non-blank
body lines, blank framing skipped. Three lines admits every real banner and refuses every essay, and
the boundary is pinned in both directions — a marker on the last opening line is read, the same
marker one line further down is prose. The residue is honest and worth stating: two lines of
narration can still precede a marker inside the window, because nothing distinguishes a narration
line from a banner line. What the window buys is that the laundering is bounded by a constant
instead of by the author's patience.

The SPDX form is anchored at both ends on its own line, so narration behind the identifier is prose
too. That end anchor is why classification never sees a carriage return: `classificationText`
strips it once, at the single site where the classifier reads a comment, so an end-anchored pattern
is safe on a CRLF checkout by construction rather than by every future author remembering. The
extractor is untouched — `comment.text` stays the byte-exact span the codemod looks for.

## Violation classes

Each class is the anchor the diagnostic's docs URL points at.

### prose

The comment matches no allowlist class. Delete it, and put the reasoning where it survives
review: the commit message, the PR body, `AGENTS.md`, or the spec.

### banned-directive

`@ts-ignore`. Replace with `@ts-expect-error <reason>`, which fails once the underlying error
disappears.

### unreasoned-directive

`@ts-expect-error` or `@lintignore` with nothing after it. Append the reason inline.

### invalid-precedent

A `precedent #N` citation whose number is not a slot in `PRECEDENTS.md`. Cite a real precedent
or drop the citation.

### retracted-precedent

A `precedent #N` citation whose slot was retracted. The slot survives so the citations written
before the retraction still resolve to something, but the rule it names no longer holds, so the
citation no longer licenses the comment. Cite the entry that superseded it, or state the
constraint without a citation. Where neither is true the comment was never carrying a contract
and goes.

### invalid-upstream-referent

`UPSTREAM(…)` whose referent matches none of the four accepted shapes. A referent that cannot be
resolved is not a citation.

### rot-in-survivor

An allowlisted comment carrying a process-citation token — a spec decision marker, a user-story
or requirement ID, a tracker ticket, a dated audit narrative, a line-number pointer. The
allowlist admits the comment's *purpose*, not a place to park process trail.

Three of these signatures are context-sensitive, because their shapes collide with platform
vocabulary this repo genuinely uses: `M1`-`M4` name Apple Silicon parts, `AC3` is an audio codec,
and `D-BUS` is the Linux desktop bus. Each of those three carries its own term list
(`CONTEXT_TERMS` in `rot.mjs`), and a comment matching its list is exempt from that signature
alone - codec words do not excuse a decision marker, and hardware words do not excuse an
acceptance criterion. Every term is held to the same closure discipline as the signatures: a term
with no negative fixture fails the suite.

The exemption is comment-scoped, and that is a deliberate accepted looseness rather than an
oversight. A comment that names platform vocabulary *and* separately carries genuine process
metadata keeps the metadata: `// STOP: M3 chip scaling blocks the M7 milestone` is admitted whole,
because `chip` exempts the milestone signature for the entire comment. Separating the two would
mean distinguishing a cue that explains the token from one that merely shares the sentence, which
no positional rule does - the distance between `arm64 ... M1` (must be exempt) and
`D-Bus ... D12` (should fire) is four characters. The fixtures name this trade explicitly.

## Scope

The `**/*.private.*` exclusion is a mirror-correctness carve-out, not a comment-policy one:
those files are stripped from the public export, so their contents may reference private trees
the mirror cannot resolve. The infix is not an escape hatch from this policy — a `.private.`
file still ships INTERNALLY, still rots, and review holds it to the same bar; the gate skips it
only because the mirrored predicate cannot see it anyway.

Scope is declared, not compiled in: `no-comments.config.jsonc` at the repository root names the
grammar families (an extension list plus an extractor id), the named units that cross a family
with a list of roots, and the exclusion set. Membership is DERIVED from `units[].roots` crossed
with the family's extensions, plus any explicit `units[].files`; the walk roots and the
directories discovery prunes derive from the same declaration. `scope.mjs` compiles that config
and nothing else, so an adopter points the predicate at their own root and gets their own scope.
Read the config rather than a restatement here: this paragraph has drifted from the real scope
twice, because an enumeration in prose has nothing checking it.

`scope.test.mjs` also pins discovery against `git ls-files`, so an in-scope file git does not
track yet fails it by name: track it if it is source, move it outside the declared roots if it is
scratch, or add it to `exclude` if it is generated output.

A family that no unit names is declared but ungated: it gives the extractor a grammar to read
that extension under, while contributing nothing to membership. That is how a family reaches the
predicate before it reaches the gate, and it is what the yaml family is today.

A `**/<name>/**` exclusion additionally prunes any directory called `<name>` during discovery —
without it the walk descends into `node_modules` and its symlink farm. A path-shaped exclusion
(`docs/.source/**`) filters but does not prune. `version` names the schema major the
file is written against: a major the predicate does not recognise is refused by name, while an
unknown additive key under a recognised major loads and is reported. A root or file the config
declares but the tree lacks is recorded as declared-absent rather than raised as an error, which
is what lets the public mirror ship a config naming roots the export drops.

Every path-shaped value the config carries -- `units[].roots`, `units[].files` and `exclude` --
is canonicalized once at load, so the matcher, the existence probe, the walk and the sweep all
read one spelling: a leading `./` is stripped, repeated slashes collapse, a trailing `/` is
dropped, and `.` is the only spelling of the repository root. Braces expand first, so a `./`
hiding inside an alternation member is canonicalized too. Two spellings that name the same path
therefore declare the same membership; before this was done at load, a `./`-prefixed entry
reached the existence probe through the filesystem and the matcher as a literal, and the two
disagreed silently. An absolute path or a `..` segment is refused by name with its key path
instead of being normalized: both name a tree the root does not own, discovery only ever
descends from the root, and rewriting either one would move a unit somewhere nobody declared.

The matcher is hand-rolled for the same reason the two lexers are, and the reason is a constraint
rather than a preference: `scope.mjs` sits inside the write-time hook's import closure, which
`scripts/no-comments-hook.test.mjs` pins to `node:` built-ins and this directory's own modules, so
nothing it reaches may import an installed package. Like the hook itself, that test is
upstream-only and no mirrored test replaces it, so on a public clone the constraint is a rule
without a gate: adding an installed dependency here reds nothing locally and surfaces only when
the change is bridged back. The named analog is `picomatch` — zero runtime
dependencies, `makeRe(glob)` returning a `RegExp` — already resolved in this workspace's lockfile,
so availability is not what rules it out. It is also the referent the refusals measure against:
where `expandBraces` says "the reference expanders", the expanders are `picomatch` and
`micromatch`. Only `*`, `**`, literal segments and comma alternations are implemented, and every
other shape is refused by name rather than compiled into a pattern that governs a set the config
never wrote.

This directory ships to the public mirror, which means its own tests may not *spell* a
`*.private.*` path: the mirror's content-leak gate rejects a named reference to one in any
shipping file. `scope.test.mjs` composes those paths from parts for that reason, and a test
added here has to do the same.

### Symlinks are refused, never followed

Discovery walks real entries only. Any symlink it meets that would otherwise have contributed —
one whose own path is in scope, and one that resolves to a directory the walk would have descended
— is recorded as a skip, and `discoverInScopeFiles` throws rather than return a list that quietly
lost a subtree. `discoverInScopeFilesWithSkips` is the exported escape hatch for a caller that
wants to handle skips itself. Both refuse to run without `lstatSync` and `statSync`: `lstatSync`
is what tells a link from a real entry, `statSync` is what tells a link-to-a-directory from a
link-to-a-file, and passing one where the other belongs makes the whole branch unreachable while
the corpus silently widens to whatever the links point at.

## The lexer

### Why not `context.sourceCode.getAllComments()`

The oxlint rule re-lexes `sourceCode.text` with the shared zero-dep extractor instead of using
the runtime's parsed comments, so the backstop sweep — which must run with no plugin runtime at
all — and the rule agree on the comment set by construction (spike-verified equivalent 4/4;
the differential test pins the extractor against a ts-morph oracle over a committed case table).


### Position model

Every position in this family is a UTF-16 code-unit offset into the file's text; offsets are
the only position currency that crosses a module boundary. Source text is never iterated by
code point (no `[...source]` / `Array.from(source)` over source), because that silently
re-indexes astral characters. `line`/`column` are a rendering, not a position: they count LF
only, exist for human-facing CLI and hook output, and are never handed to another tool that
owns its own line map — the oxlint rule reports ranges and lets oxlint render them with its
own ECMAScript-terminator line map.

`extract.mjs` finds comments without a parser, because the sweep, the hook, and the public
mirror all need to run without a TypeScript dependency. It is a single-pass state machine over
`code`, `template`, `jsxTag`, and `jsxChildren` frames, and it resolves the two genuine
ambiguities by leaning toward comment recall:

- **`/` — regex or division?** A regex may only start where a value may not have just ended, so
  the scan checks the previous significant token. After `)`, `]`, `}`, an identifier, a number,
  a string, or a value keyword, `/` is division. Everything else opens a regex. A regex literal
  cannot span a line, so a scan that reaches a newline rewinds and treats the `/` as division —
  which keeps a trailing comment on a line of arithmetic visible.
- **`<` — JSX or comparison?** Only in `.tsx` / `.jsx`, and only in expression position. A type
  parameter list is separated out by its `,`, its `extends`, or the `(` that follows its closing
  `>`. Reading JSX as generics costs a line; reading generics as JSX would swallow the rest of
  the file, so the tie breaks toward generics.

A `.private.` differential test pins the lexer against a TypeScript-backed oracle across every
in-scope file in the repository.

### The hash family

`extract-hash.mjs` is the second lexer, reading the families whose comment opens with `#`. It
shares the position model and the zero-dependency property, and it dispatches on a dialect
resolved from the file's extension — or, for an extensionless unit member, from the extensions
its family declares. An extension no dialect claims is refused by name rather than read under a
neighbouring grammar, because reading one family's bytes with another family's lexer does not
fail quietly: the slash lexer over shell source finds no `#` comment at all and invents one out
of the `//` in a URL.

Three dialects: `shell`, whose word-initial rule and frame stack are the hard case (heredoc
queue, command substitution, parameter expansion, arithmetic, ANSI-C quoting); `yaml`, which
adds block scalars and narrows the word rule to whitespace; and `python`, whose `#` needs no
word rule at all. `shell` and `yaml` each carry their own comment-position
reference — the pinned `shfmt` differential and the `yaml` package's CST. `python` carries none
yet, and is the one dialect no family declares: it reaches a family only once a reference lands,
because a pinned Python tokenizer is a heavier provisioning step than shfmt's one static binary,
and CPython's own `tokenize` changed its f-string tokens in 3.12, so an unpinned interpreter
would give a version-dependent verdict. The lexer is measurably wrong on that same change: it
carries no replacement-field awareness and closes a string at the next occurrence of the opening
quote, so PEP 701 same-quote nesting ends it early and the remainder is scanned as top-level code.
`x = f"{d["a#b"]}"` yields a line comment `#b"]}"` at column 12, which a `--write` strip would
delete, leaving the truncated `x = f"{d["a`; Black shipped the same class of bug
(`psf/black#4056`). So a family declaring `.py` is not merely undeclared by convention: the
grammar contract refuses it at config load, naming the dialect and the reference it lacks, because
an adopter pointing `--root` at their own config would otherwise take gate verdicts and strip
ranges from a lexer nothing measures. Line one is structural in the dialects that have a line-one grammar —
a shell or python shebang, and python's PEP 263 coding cookie on either line the PEP allows —
so the extractor emits it under its own kind and no lane ever reports it as a comment.

Multi-line markers work differently here. A `#` comment is one line, so a marker whose
continuation is indented under its head is joined into one comment by the classifier, never by
the extractor; the join keeps the byte-exact span, so a stripper deletes exactly what it read.
An unindented following line stays a separate comment and is prose.

The shell dialect's reference is `shfmt`, the Go binary. The npm port weighed when the pin was
chosen, `mvdan-sh`, is 0.10.1, published 2022, and lags the build this pin names by roughly four
years, so it would have been a different oracle rather than the same one packaged differently.
That reasoning covers that package and not the class: whether some port that does track this build
could replace the binary is an open engine question, not a settled one. Its pin is a second
registry no dependency automation watches: a `SHFMT_VERSION` constant in `scripts/shfmt.mjs` plus a hand-maintained
four-platform sha256 table beside it, which the resolver checks the provisioned copy against and
`scripts/provision-shfmt.mjs` checks the download against, neither reachable from
`package.json`, the lockfile, or Dependabot. A platform the table has no row for is the one case
the two read differently: the provisioner refuses to download at all, while the resolver keeps the
version check and warns that this copy went unverified, naming the missing row — the pin's job is
to let a divergence be attributed to the printer it names, and an unverified copy cannot carry that
attribution quietly. Refreshing it means replacing four release-asset
digests — mvdan/sh publishes no checksums file, signature or build attestation with its releases,
so those four pin one observed download rather than a publisher's statement, and the only
non-circular check available is an independent rebuild from the recipe the release notes state —
moving the version constant the differential asserts, and re-running the whole shell
unit under the new build to confirm `-mn` output is byte-identical before the pin moves. That
re-measure has been run once, for 3.14.0: the pin held at 3.13.1 because
`scripts/lume-bake/probe-chromium-prefs.sh` emits its `then` on a different line under the newer
printer.

## Rebasing an in-flight branch across the cleanup

The cleanup commit deletes comment lines across the whole scope at once, so a branch that forked
before it will conflict wherever its own edits sit within a few lines of a deleted comment. Edits
further away from any deleted comment merge clean and need nothing.

Two conflict shapes, two resolutions:

1. **Both sides of the hunk differ only in comments** - your branch reworded or moved a comment the
   cleanup deleted. Take main's side. No code is lost, and the result is token-identical to what
   your branch had.

2. **Your code change sits beside a deleted comment**, so the hunk carries both. Do NOT take main's
   side: it would silently drop your change. Re-run the codemod on your branch's files and commit,
   then merge again. The codemod is idempotent, so both sides now carry the same deletions and the
   remaining conflict is your own change with no comments in it - resolve it by taking your side.

Run these from the repository root of the monorepo checkout (`public/open-knowledge/` there); a
public clone carries the oxlint rule and a `lint` with no sweep leg, but neither the codemod, the
shfmt provisioner nor the write-time hook, so the recipe below does not apply to it:

```bash
pnpm run provision:shfmt
node scripts/comment-codemod.mjs --write
```

`provision:shfmt` is only needed when the branch touches a shell file: the codemod's shell oracle
reads the pinned build by absolute path and refuses rather than guessing when it is absent.

The exit code is the machine half of that recipe, so a chained command can branch on it:

| code | meaning |
|---|---|
| 0 | clean: nothing was refused, and with `--write` everything in scope was stripped. `--write` is opt-in, so a plain invocation is a dry run that reaches this code having written nothing — 0 means "no file was refused", never "the tree was rewritten". The report's first line says which of the two ran, and a dry run labels its counters `would change` / `would remove`. A protected-region hit is reported but does not change the code, so a run whose only outstanding item is a protected region also exits 0 |
| 1 | a file was refused, so nothing was written for it and the run carried on. Each reason prints as the literal below. `identity-divergence`, the strip failed its family's oracle — a significant-token mismatch for the c-family; a `shfmt -mn` canonical-form mismatch, a changed shebang or a `bash -n` rejection for shell — and `kept-comment-lost`, an allowlisted comment the strip removed: both are bugs to report rather than rebase steps. `non-utf8-bytes`, a file whose bytes do not round-trip UTF-8 (decoding it would rewrite them as U+FFFD, so the codemod never decodes it) — convert or exclude it by hand. `no-grammar`, a path no family claims — declare it in the config or leave it out. `no-identity-oracle`, a family the codemod cannot prove a strip invariant for. `source-changed-since-plan`, a file another writer rewrote between the read that planned the strip and the write — re-run. `source-unreadable-at-flush`, a planned file that could not be re-read before its write — fix the permission or the missing path; re-running alone will not clear it. Where a reason carries more detail the report prints it in parentheses after the name. A refusal outranks pending human work, so a run that also leaves rot survivors or over-cap citations exits 1, not 3 — branch on 1 before 3, and read `--proposals` on both, since it is written whenever the flag is passed and the run completed, whatever the code |
| 2 | the invocation was refused before any work: an argument the parser does not claim (printed as `unrecognized argument(s): <tokens>`, followed by the accepted grammar), including a bare path — name files with `--file <path>` — a value-taking flag other than `--file` passed twice (`repeated argument(s): <flags>`, since the parser resolves one to its first occurrence), a value-taking flag (`--root`, `--file`, `--manifest`, `--proposals`, `--reader-probe`) with no path after it, a `--file` outside `--root`, a `--file` no unit claims, a scope config that does not load (printed as `scope-config: UNREADABLE` with the offending key, or `scope-config: NOT FOUND` on a root that declares none), a precedent registry that does not load (printed as `precedent-registry: UNREADABLE` with the manifest key or the PRECEDENTS.md numbering problem behind it), an absent pinned `shfmt` when a target is shell (printed as `shfmt v<version> is not available` — run `node scripts/provision-shfmt.mjs`; the tree is untouched in both lanes), `--write` with no protected-region net, or `--write` where a target's family has no registered identity oracle — under `--allow-unscoped`, no family at all. Oracle availability is knowable before a byte is read, so it refuses the whole invocation rather than skipping the file. Any other internal error also exits 2; every file is planned and verified before the first is written, so an error while planning leaves the tree untouched, and an error while writing names every file whose rewrite landed; the file that aborted is untouched, because each write is staged beside its target and renamed over it only after the staged bytes are read back and matched |
| 3 | a human still has work, and with `--write` everything writable was written: `rot-in-survivor`, a rot token inside an otherwise legitimate marker, left in place for you to strip by hand and counted in the summary as `rot-refused`; or `citation-over-cap`, a citation comment past the three-line cap, counted as `over-cap`, whose trimmed candidates the `--proposals <path>` channel carries — and nothing was refused; a refusal outranks this and takes the run to 1 with the same records still written. A dry run reaches this code too, having written nothing |

`--manifest <path>` writes the deletion manifest, and `--reader-probe <path>` writes the
machine-read probe's record — the one that says whether a removed marker still has a reader, and
whether it could enumerate the tree to find out at all.

Two of the exit-2 refusals have an override, and neither is a default. `--allow-unprotected`
writes without the mirror's protected-region net. `--allow-unscoped` strips `--file`-named paths
in a tree carrying no `no-comments.config.jsonc`, reading them under a fixed fallback family map
that the run announces; it does not enable enumeration, so an unscoped tree with no `--file` is
refused outright.

A protected-region collision exits 0 by design. It means the comment overlaps a span the mirror
manifest pins, so declining to touch it is the correct terminal state rather than pending work -
the report still names it. Under `set -e`, note that 3 is a success in the human sense: the files
that could be written were.

Both resolutions are pinned by `scripts/comment-codemod.test.mjs`, which replays each shape through
a real `git merge` in a throwaway repository and checks the result with the token-stream oracle.

`scripts/comment-codemod.mjs` is upstream-only: `scripts/` is enumerated in the mirror manifest
rather than globbed, so the codemod does not ship to the public repository. Rule 1 needs no tooling.
