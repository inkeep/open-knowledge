<p>
  <a  href="https://openknowledge.ai"><picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/ok-wordmark-dark.svg">
    <img src="assets/ok-wordmark.svg" alt="OpenKnowledge" width="260">
  </picture></a>
</p>

<p>
<b>OpenKnowledge</b> is a beautiful markdown editor with integrations with Claude, Codex, and other harnesses. For knowledge bases, LLM wikis, specs, and notes. Private, local, and free.

</p>

<div >
  <a href="https://openknowledge.ai">website</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="https://openknowledge.ai/download/stable">macOS app</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="https://openknowledge.ai/docs/get-started/quickstart#ok-install-web-app-linux-windows-intel-mac">web view + cli</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="https://x.com/OpenKnowledge">𝕏</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="https://discord.com/invite/YujKpFN49">Discord</a>
</div>

</br>

<img
  src="assets/hero.webp"
  alt="OpenKnowledge editor with an AI agent drafting a launch recap"
  width="100%"
  style="border-radius: 10px"
/>

# Features

Highlights:
- Full true **WYSIWYG** so that editing markdown files feels like editing a Google Doc or Notion page. 
- **macOS app** and **web UI** with file navigator, search, tabs, graph wiki link viewer, and more. 
- Collaborative **AI-editing** with **Claude, Codex, and Cursor desktop apps**. Can be used with any harness/agent via MCP/CLI, like OpenCode.
- Out-of-the-box **MCP**, **skills**, and **agentic search** for LLM Wikis, agent second brains, and knowledge graphs.
- No-code **Team sharing** and **Auto-sync** powered by git/GitHub under the hood.
- **Embeddable HTML** and rich components for writing engineering specs and visualized reports.
- A **built-in TUI** in the Desktop app and a Web UI for users who prefer terminals.

## Install

**macOS:** download the desktop app — open the DMG, drag **OpenKnowledge** to **Applications**, and launch it. [Latest release](https://github.com/inkeep/open-knowledge/releases/latest).

**Linux, Windows, Intel Mac:** run the same editor as a local web app via the CLI ([Node.js 24+](https://nodejs.org) required):

```bash
npm install -g @inkeep/open-knowledge
cd your-project
ok init          # scaffold the project + wire up Claude Code, Cursor, and Codex
ok start --open  # serve the web editor and open it in your browser
```

## Usage

Use OpenKnowledge by opening any existing folder on your computer that contains markdown or mdx files. The app can be used with existing codebases, wikis, Obsidian vaults, etc.

Think of it as Notion meets VSCode. 

You can also start from scratch with one of the starter packs, which include e.g. a template for an LLM Wiki.

The app will automatically initialize your project with MCP and skill configs for agent harnesses detected on your computer. Git sync and sharing can optionally be enabled.

Docs for general usage: <https://openknowledge.ai/docs>.

## Contributions

Public pull requests or issues are welcome!

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License

OpenKnowledge is licensed under the [GNU General Public License v3.0 or later](./LICENSE) (`GPL-3.0-or-later`).

## Support

Feel free to <a href="https://github.com/inkeep/open-knowledge/issues/new/choose">file an issue</a> or ask questions on the <a href="https://discord.com/invite/YujKpFN49">Discord</a> community.

<p>
  ⭐️ If you'd like to support this project, consider starring the repo ⭐️
</p>

<p>
  🔔 Follow us on <a href="https://x.com/OpenKnowledge">𝕏</a> for product updates. 🔔
</p>
