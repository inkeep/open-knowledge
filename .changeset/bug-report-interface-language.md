---
"@inkeep/open-knowledge": patch
---

Bug reports now record which language the app was in when they were filed, and the app reports when someone changes that setting.

Until now a report said nothing about the interface language, so a problem that only happens in one language — text running the wrong way, a label that overflows its button, a date read the wrong way round — arrived looking like it happened in English. Reports now carry the language setting exactly as it was chosen, what it resolved to at that moment, which of the four tiers decided (an environment override, the saved choice, the operating system, or the fallback), and the system language list that tier read. That last part matters most for the default setting, "System": on its own it says nothing, and beside the resolved language and the list behind it, the difference between the app guessing wrong and the operating system being set to something unexpected becomes visible without a round of questions.

Reports filed from the desktop app record the language actually on screen, including a change made moments earlier that has not finished saving — which is the report someone files when changing the language appears not to take. Only the interface language is recorded; document text, titles, and filenames are untouched, and nothing about their contents is described.

The app also now reports when the language setting is changed, so which languages people choose can inform which ones get translated next. It records the previous and new setting only — "System" stays "System" rather than being resolved to a specific language, so choosing English deliberately stays distinguishable from inheriting it. As with all product telemetry this is off unless telemetry is enabled.
