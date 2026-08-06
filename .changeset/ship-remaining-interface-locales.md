---
"@inkeep/open-knowledge": minor
---

**Settings → Preferences → Language** now offers nine languages instead of three. 繁體中文, हिन्दी, Français, বাংলা, Português do Brasil and Indonesia join English, Español and 简体中文 in the picker, and the app will follow your operating system into any of them.

These catalogs were always complete — the six new ones have been shipping fully translated since language selection landed, just with no way to select them. They were held back until a native speaker had read them, which turned out to be the wrong way round: the people who could tell us a translation reads badly were exactly the people who never encountered it. So they ship, and we say plainly that most of them have not been read.

That last part is not a formality. Of the nine, only English (the source) and Español have been through someone who reads the language. The rest, 简体中文 included, are a machine's best guess against a locked glossary. If you read one of them and something is wrong — a word that no one would actually use, a sentence that parses but does not land — [it takes one pull request to fix](https://openknowledge.ai/docs/contribute/translations), and that is now the only way it gets fixed.

العربية and اردو stay out of the picker. Their catalogs are complete too, but the interface's right-to-left layout is unfinished: some labels stay left-aligned, some arrows keep pointing the way they did, and section headings are letter-spaced in a way that pulls Arabic apart at the joins. Both remain selectable by hand via `appearance.language` so a contributor can still check the words, and the app will not drop you into either from your OS language alone.
