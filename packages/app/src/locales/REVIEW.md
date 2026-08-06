# Locale review and promotion

OpenKnowledge enumerates eleven interface locales and offers three of them in the language
picker. The other eight have complete catalogs that nobody can select. That gap is deliberate,
and this file is how a locale crosses it.

Completeness is not the bar. Every catalog in `src/locales/` is full, because the agent that
writes a string writes its ten translations in the same change. What ten of them have not had is
a reader — someone who reads the language telling us the words are right. Offering a language in
the picker is standing behind it, and we can only stand behind what someone has read.

So: **a locale enters the picker when someone who reads it has reviewed it.** Nothing else
promotes one. Not 100% coverage, not a green CI run, not another model agreeing with the first.

## The state of each locale

| Locale | Language | Status | Basis | Evidence | Blocked by |
| --- | --- | --- | --- | --- | --- |
| `en` | English | source | — | — | — |
| `es` | español | vouched | A Spanish-reading team member | Audited in-product during the initial rollout; no packet review on record | — |
| `zh-Hans` | 简体中文 | vouched | Requested externally; serves as the coverage instrument | Stray English is unmissable inside Han script, so coverage is verified — but no reader of Chinese has judged the wording | — |
| `zh-Hant` | 繁體中文 | unreviewed | — | — | — |
| `hi` | हिन्दी | unreviewed | — | — | — |
| `ar` | العربية | unreviewed | — | — | right-to-left layout |
| `fr` | français | unreviewed | — | — | — |
| `bn` | বাংলা | unreviewed | — | — | — |
| `pt-BR` | português (Brasil) | unreviewed | — | — | — |
| `id` | Indonesia | unreviewed | — | — | — |
| `ur` | اردو | unreviewed | — | — | right-to-left layout |

`source` is the catalog whose `msgstr` is the English text itself; there is nothing to review.

`unreviewed` is a complete, machine-checked catalog no native reader has seen. Eight of eleven.

`reviewed` is the bar this file describes: someone who reads the language read it and said so
where a stranger can find it. **No locale holds this status yet.** The first one to earn it will
be the first promotion this process actually produced.

`vouched` is weaker, and exists so the two locales that shipped in the picker before this process
did are recorded truthfully rather than rounded up. Neither has had a native review; each was
offered for a stated reason that is not one. Recording it this way is not an accusation, it is
the point of having a record: `zh-Hans` in particular is the locale most likely to have real
users and the one with no reader, which makes it the obvious first packet to send out.

A **blocker** is a reason the locale cannot be offered even with a clean review. Both current
blockers are the same one: the chrome still lays out with physical margins and insets rather than
logical ones, so a right-to-left base direction over it is visibly wrong rather than merely
unpolished. That is a layout problem no translation fixes, and it is deferred until an
Arabic- or Urdu-reading user or contributor appears. Their catalogs stay complete and
freshness-gated in the meantime.

Those two are also the reason the packet is a file rather than an instruction to run the app: a
contributor who opened OpenKnowledge in Arabic today would be looking at a broken layout, so
"run it in your language and tell us how it reads" is advice that works for eight locales and
fails for the two that need it most. A packet works for all ten.

This table is parsed, not just read: `scripts/generate-locale-review-packet.mjs` refuses to build
a packet for a locale with no row here, and `scripts/generate-locale-review-packet.test.mjs` pins
it against `SUPPORTED_LOCALES`, `PICKER_LOCALES` and `LAYOUT_DEFERRED_LOCALES`. A row cannot drift
away from the code it describes without failing the suite.

## Running a review

### 1. Build the packet

```bash
node scripts/generate-locale-review-packet.mjs fr --out /tmp/fr-review.md
```

One Markdown file, no links into a checkout. The reviewer needs a text editor and nothing else —
no clone, no install, no running app. That constraint is the point: the people who can do this
review are not necessarily people who can run the repo.

It samples roughly a hundred strings out of ~2,900, chosen by a fixed rule: the whole locked
glossary, then the glossary words in real messages, then the highest-traffic chrome, shortest
strings first. Asking for 2,900 gets the request declined or skimmed, and a skimmed review of
everything is worth less than a real review of the part that matters. The script's header states
the rule; so does the packet, so the reviewer knows what they are being handed.

A contributor who *can* run the app should also run it in their language — `OK_LANG=fr ok start`
activates any enumerated locale, promoted or not. That is a better review than the packet. The
packet exists so that not being able to do it is not a blocker.

### 2. Send it out

Community translation runs through public pull requests against `inkeep/open-knowledge`. Attach
the packet, or paste it into the issue or PR thread. Ask for what the packet asks for: a list of
numbered strings to change, and what they should say.

### 3. Land what comes back

Corrections are ordinary catalog edits. Fill the `msgstr` in `src/locales/<locale>/messages.po`,
run `pnpm --dir packages/app run i18n` to recompile, and commit the catalogs. If a correction
changes one of the locked nouns, change it in [`GLOSSARY.md`](./GLOSSARY.md) **and sweep every
message in that locale that uses the old form, in the same change** — a half-swept rename leaves
the catalog holding two words for one concept, which is worse than either word alone.

### 4. Record the review

Update this file's table in the same PR: `Status` to `reviewed`, `Basis` to the reviewer's name or
handle, `Evidence` to something a stranger can follow back — a PR number, an issue link, a thread.
"An agent reviewed it" is not evidence and does not count; the entire reason this process exists
is that a model checking another model's translation tells us nothing new.

A review that comes back with corrections is still a review. What decides the status is that a
reader of the language read it, not that they had nothing to say.

`git add` this file before running `pnpm check`. The catalog-drift guard diffs the whole of
`src/locales/` against the index, so an unstaged edit to this file or to `GLOSSARY.md` is
reported as catalog drift and sends you off to re-run an extractor that will change nothing.

## Promoting a locale

One line, in `packages/core/src/i18n/locales.ts` — adding the tag to the tuple. Promoting `fr`
would read:

```ts
export const PICKER_LOCALES = ['en', 'es', 'zh-Hans', 'fr'] as const satisfies readonly SupportedLocale[];
```

That is the whole change. Everything downstream derives from that tuple:

- The Settings picker renders `PICKER_LOCALES`, so the language appears with no UI edit.
- `scripts/check-i18n-picker-completeness.mjs` reads the same tuple and starts gating the new
  locale absolutely — a picker entry backed by a partial catalog fails CI from that commit on.
- `packages/app/tests/meta/supported-locales-sync.test.ts` already pins `SUPPORTED_LOCALES`
  against the Lingui config, so the catalog behind the tuple is guaranteed to exist.

Ship it with the table update in the same PR, so the picker and the record of why it changed
arrive together.

A locale carrying a blocker does not get this change, however clean its review. Record the
review, leave the blocker, and promote when the blocker lifts — a reviewed Arabic catalog behind
a layout that renders it wrongly is still not something to offer anyone.

## Adding a locale nobody asked for

Don't. Every enumerated locale costs a translation on every new string, forever, and buys nothing
until someone reads it. The eight unpromoted catalogs are already more than the review capacity
this project has; adding a twelfth makes the ratio worse, not better. The signal worth acting on
is a person who wants the language and will read it.
