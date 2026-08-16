# Locale review and promotion

OpenKnowledge enumerates twelve interface locales and offers ten of them in the language
picker. The two it withholds are withheld for a layout reason, not a translation one. This file
records which of the ten a reader of the language has actually read, which is a different
question from which ones are offered, and it is the file to update when that changes.

Completeness is not the bar and never was. Every catalog in `src/locales/` is full, because the
agent that writes a string writes its eleven translations in the same change. What most of them
have not had is a reader — someone who reads the language telling us the words are right.

**Being unread does not hold a language back from the picker.** It used to, and the effect was
backwards: the people who could tell us a translation was wrong were the same people who could
never encounter it, because it was not offered to them. So the ten ship, they ship labelled as
machine-translated where that is what they are, and corrections come back through
[the translation page](https://openknowledge.ai/docs/contribute/translations) as ordinary pull
requests.

What that does not do is let us claim they are reviewed. The table below is the whole of that
claim, and most rows say `unreviewed` for as long as that is true.

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
| `ko` | 한국어 | unreviewed | — | — | — |

`source` is the catalog whose `msgstr` is the English text itself; there is nothing to review.

`unreviewed` is a complete, machine-checked catalog no native reader has seen. Nine of twelve,
and seven of those nine are offered in the picker anyway. That pairing is the honest state of
this project's interface translations and the reason this file exists.

`reviewed` is the bar this file describes: someone who reads the language read it and said so
where a stranger can find it. **No locale holds this status yet.** The first one to earn it will
be the first review this process actually produced.

`vouched` is weaker, and exists so the two locales that shipped in the picker before this file
did are recorded truthfully rather than rounded up. Neither has had a native review; each was
offered for a stated reason that is not one. Recording it this way is not an accusation, it is
the point of having a record: `zh-Hans` in particular is the locale most likely to have real
users and the one with no reader, which makes it the obvious first packet to send out.

A **blocker** is a reason the locale cannot be offered however good its catalog is. Both current
blockers are the same one, and it is about layout rather than words. Their catalogs stay
complete and freshness-gated in the meantime.

## The right-to-left blocker, in detail

`ar` and `ur` are complete and correct as text. What is not finished is the chrome around the
text. Setting `dir="rtl"` does mirror most of it — the shell is flex and grid, which follow the
writing mode without being asked, and user-authored text isolates via `dir="auto"` so filenames
and document bodies keep their own direction. What remains, measured against a running app with
`appearance.language: ar` and `<html dir="rtl">`:

- **Text that stays left-aligned inside a right-to-left pane.** `text-left` sits outside the
  logical-property lint rule's scope by design, and forty-odd uses survive in the chrome. Six
  computed to `text-align: left` on the document surface alone — the same six as in English,
  which is what makes them wrong rather than incidental.
- **`ml-auto` spacers that push the wrong way.** They mean "shove this to the far end of the
  row", which under `rtl` becomes the near end. Trailing affordances land beside their labels
  instead of opposite them.
- **Arrows, chevrons and disclosure triangles that do not mirror.** They are static icons, so a
  right-pointing chevron keeps pointing right when forward has become left. The panel-collapse
  control is the one you see first; there are around 150 directional icon uses in the chrome.
- **`tracking-*` on section headings.** The most visible defect, and the one least about
  direction: 0.7px of letter-spacing on `الملفات`, `الخصائص`, `المخطط` and every command-palette
  group heading pulls Arabic apart at the joins, which for a cursive script is not a spacing
  change but a rendering fault.
- **Physical margins and padding landing on the far side.** Small individually, systematic in
  aggregate.
- **The Electron menu bar**, built in the main process, with no direction handling at all.

A green `pnpm check` is not evidence against any of this. The logical-property lint rule carries
a documented pre-rule backlog — a file-level `biome-ignore-all` on the 81 chrome files that
predate it, covering around 148 utilities — and the shadcn primitives under `components/ui/` are
exempt from it entirely while holding well over a hundred physical utilities of their own. The
rule is a ratchet on new code, not a statement about the code already there.

None of that is a reason not to review the words. It is a reason not to offer the language while
the layout renders them wrongly, and it is why the packet below is a file rather than an
instruction to run the app: a contributor who opened OpenKnowledge in Arabic today would spend
the hour on defects that are not theirs.

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

A contributor who *can* run the app should also run it in their language — the picker offers
ten of them directly, and `OK_LANG=ar ok start` activates the other two. That is a better
review than the packet. The packet exists so that not being able to do it is not a blocker.

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
"An agent reviewed it" is not evidence and does not count; the entire reason this record exists
is that a model checking another model's translation tells us nothing new.

A review that comes back with corrections is still a review. What decides the status is that a
reader of the language read it, not that they had nothing to say.

`git add` this file before running `pnpm check`. The catalog-drift guard diffs the whole of
`src/locales/` against the index, so an unstaged edit to this file or to `GLOSSARY.md` is
reported as catalog drift and sends you off to re-run an extractor that will change nothing.

## Offering a locale

One line, in `packages/core/src/i18n/locales.ts` — adding the tag to `PICKER_LOCALES`. Everything
downstream derives from that tuple:

- The Settings picker renders `PICKER_LOCALES`, so the language appears with no UI edit.
- `scripts/check-i18n-picker-completeness.mjs` reads the same tuple and gates the new locale
  absolutely — a picker entry backed by a partial catalog fails CI from that commit on.
- `packages/app/tests/meta/supported-locales-sync.test.ts` already pins `SUPPORTED_LOCALES`
  against the Lingui config, so the catalog behind the tuple is guaranteed to exist.

The tuple is pinned equal to the enumerated set minus `LAYOUT_DEFERRED_LOCALES`, so in practice
a locale is offered as soon as it is enumerated and carries no blocker. Holding a new one back
means recording a blocker for it, in the table and in the tuple, where a reader can see what the
reason is.

Recording a review is the separate change described above, and it moves the picker in neither
direction: an unreviewed locale is already offered, and a review that comes back with
corrections is a request for edits rather than a removal. A reader telling us the language is
not usable as it stands is the one answer worth acting on that way, and worth writing down.

## Adding a locale nobody asked for

Don't. Every enumerated locale costs a translation on every new string, forever. Twelve is
already more than the review capacity this project has; adding a thirteenth makes the ratio worse,
not better. The signal worth acting on is a person who wants the language and will read it.
