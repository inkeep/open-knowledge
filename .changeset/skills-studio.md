---
"@inkeep/open-knowledge": patch
---

Skills now live on a settings page named after them. Installing a skill used to be filed under **AI tools & CLI**, while the page called **Skills** held nothing but folder symlinks and never said what symlinking was for — so people looking for a skill looked in the wrong place, and the right place explained nothing. Both scopes now have **Skills Studio**: the skills OpenKnowledge ships (or the project's own skill) on top, and the folders your AI tools read them from below, under a heading that leads with the reason rather than the mechanism. The AI tools pages keep the connections and point at where skills went.

Each skill row now says what the skill does in a line written for a person. It previously printed the skill's own `description`, which is trigger text written for an agent — the discovery skill's runs several hundred characters and ends by telling a model what not to do. The full text is still one click away in the skill's preview, and still what the install confirmation quotes.

`ok init` no longer installs `open-knowledge-write-skill` unless you ask for it with `--skills write-skill`, matching what the desktop's first launch already does. A skill nobody was asked about is not installed on their behalf, and an existing copy is never removed. Because that leaves the authoring skill undiscoverable rather than merely unrequested, the first time you open Skills Studio it explains the page and offers the skill once — dismissible, remembered, and never shown for a skill you already declined.
