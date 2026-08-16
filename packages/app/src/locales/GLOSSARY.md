# Translation glossary

The locked vocabulary for OpenKnowledge's interface copy. Every catalog under
`src/locales/` uses these forms for these nouns, in every message that mentions them.

Terminology drift is the failure mode that structural checks cannot see: a catalog that
renders *document* as three different words is still 100% complete, still passes the
empty-`msgstr` gate, and still reads as sloppy to the one person who can tell. Most of the
strings here are written by a coding agent following
[`translate-ui-strings`](../../../../plugins/ok/skills/translate-ui-strings/SKILL.md), across
many sessions and models, so the vocabulary has to be pinned somewhere rather than re-derived
each time.

Eight nouns is deliberately small — under a hundred cells against ~2,800 catalog entries per
locale. It is the one artifact in this system short enough for a native speaker to review end
to end, which is what makes it worth more than the same effort spread over the catalogs.
That review, and which locales have actually had one, is [`REVIEW.md`](./REVIEW.md).

## Never translated

These carry through every locale byte-for-byte:

- **OpenKnowledge** — the product name.
- **Markdown**, **Git**, **GitHub**, **MCP**, **YAML**, **JSON**, **PATH** — proper nouns and
  format names.
- **frontmatter** — names a Markdown construct, the way `<head>` names an HTML one. There is no
  settled translation in any of the twelve locales, so twelve inventions is the likely outcome
  of translating it. Gloss it on first use if a sentence needs the help; do not replace it.
- **ICU placeholders** — `{name}`, `{count}`, `#` inside a plural. Renaming one silently breaks
  the substitution; the string compiles and renders the literal brace text.
- **Command names, flags, and machine-readable output** — the CLI surface is permanently
  English so scripts keep working under a non-C locale.

## The nouns

| Term | `es` | `fr` | `pt-BR` | `id` |
| --- | --- | --- | --- | --- |
| document | documento | document | documento | dokumen |
| folder | carpeta | dossier | pasta | folder |
| workspace | espacio de trabajo | espace de travail | espaço de trabalho | ruang kerja |
| knowledge base | base de conocimiento | base de connaissances | base de conhecimento | basis pengetahuan |
| wiki-link | enlace wiki | lien wiki | link wiki | tautan wiki |
| agent | agente | agent | agente | agen |
| checkpoint | punto de control | point de contrôle | ponto de verificação | titik pemeriksaan |
| branch | rama | branche | ramo | cabang |

| Term | `zh-Hans` | `zh-Hant` | `hi` | `bn` |
| --- | --- | --- | --- | --- |
| document | 文档 | 文件 | दस्तावेज़ | নথি |
| folder | 文件夹 | 資料夾 | फ़ोल्डर | ফোল্ডার |
| workspace | 工作区 | 工作區 | कार्यक्षेत्र | ওয়ার্কস্পেস |
| knowledge base | 知识库 | 知識庫 | ज्ञान आधार | জ্ঞানভাণ্ডার |
| wiki-link | 维基链接 | 維基連結 | विकी लिंक | উইকি লিংক |
| agent | 智能体 | 智慧代理 | एजेंट | এজেন্ট |
| checkpoint | 检查点 | 檢查點 | चेकपॉइंट | চেকপয়েন্ট |
| branch | 分支 | 分支 | ब्रांच | ব্রাঞ্চ |

| Term | `ar` | `ur` |
| --- | --- | --- |
| document | مستند | دستاویز |
| folder | مجلد | فولڈر |
| workspace | مساحة العمل | ورک اسپیس |
| knowledge base | قاعدة المعرفة | نالج بیس |
| wiki-link | رابط ويكي | وکی لنک |
| agent | وكيل | ایجنٹ |
| checkpoint | نقطة تحقق | چیک پوائنٹ |
| branch | فرع | برانچ |

| Term | `ko` |
| --- | --- |
| document | 문서 |
| folder | 폴더 |
| workspace | 워크스페이스 |
| knowledge base | 지식 베이스 |
| wiki-link | 위키 링크 |
| agent | 에이전트 |
| checkpoint | 체크포인트 |
| branch | 브랜치 |

## Why these forms

- **document / folder** follow each locale's own file-manager vocabulary rather than a
  transliteration, because users meet those words in their OS before they meet them here.
  `zh-Hant` takes 文件 (the Taiwanese reading of *document*) where `zh-Hans` takes 文档 — the
  two scripts genuinely diverge here, which is the whole reason they are separate catalogs.
- **branch** takes the form each language's own Git translation uses (`rama`, `branche`, `ramo`,
  `cabang`, 分支), so a user reading OpenKnowledge and reading `git status` sees one word.
- **agent** means an AI agent, not a network proxy. `zh-Hans` 智能体 and `zh-Hant` 智慧代理 are
  the current AI-context readings; 代理 alone would read as *proxy*.
- **checkpoint** is a saved state, not a security post — Arabic takes نقطة تحقق rather than
  نقطة تفتيش for that reason.
- **knowledge base** is the user's own collection of notes. Where a native compound exists and
  reads naturally it wins over a transliteration; `ur` keeps the transliteration because the
  native compound is not in common software use.
- **Follow** is the pull-only sync mode. Korean uses 팔로우 consistently rather than mixing the
  English label with 따라오기.

## Changing an entry

A locked term is only worth locking if it stops moving. Changing one means sweeping every
message in that locale that uses it, in the same change — otherwise the catalog holds two
words for one concept, which is worse than either word alone. Adding a row is cheap; retiring
one is not.
