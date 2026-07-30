# Bundle-size limits — rationale and history

The `size-limit` entries in `package.json` are hand-maintained: `size-limit` ships
no auto-update or ratchet, so each limit is measured and then edited by hand. This
file records *why* each limit moved, so that reasoning survives without living on a
single line of `package.json` that every branch has to append to.

The limits themselves stay in `package.json` — they are read by the
`open-knowledge / size` CI job. Only the narrative moved here.

## Open follow-ups

TODO: check why after installing @pierre/trees has exceeded by 55 kB.

- PropertyPanel pulled date-fns + react-day-picker into the eager bundle (~24 kB) — follow-up should lazy-load DateWidget so the calendar/date-fns chunk only loads on first date-property edit.
- @dnd-kit adds ~15 kB to the eager bundle (PropertyPanel imports it at top level) — follow-up should lazy-load PropertyPanel itself so dnd-kit + the widget zoo only load when a doc has frontmatter.
- terminal multi-session added ~2.65 kB to the eager bundle (TerminalTabStrip + the Radix Tabs primitive) — follow-up should lazy-load TerminalDock, which is desktop-only (gated on terminalBridge) and ships as dead weight in the web bundle.
- the bottom Ask AI composer (BottomComposer + AgentSplitButton) sits in the eager bundle though it is desktop-only (gated on isDesktop) — follow-up should lazy-load BottomComposer so it stops shipping as dead weight in the web bundle (would reclaim ~4 kB).

## Limit-change history

Limit raised 410->450 kB after merging main + the skill/template editor feature; the skill-specific UI (ManagedArtifactProperties, SkillEditorActions) is already lazy-loaded, so the residual is the pre-existing PropertyPanel tech-debt above — lazy-loading PropertyPanel should bring this back under 410.

Main CSS limit raised 49->52 kB after merging main + the skills-as-content UI — Tailwind utility accretion across many new surfaces, no single bloat source and no lazy-load lever for global CSS.

Limit raised 450->454 kB after merging main + the worktree selector feature (base-branch picker with local/remote search, flyout keyboard nav, project-navigator icon tiles); ~2 kB of this bump is concurrent main growth (incl. terminal-chat-controls #2350) merged in during finalization, and the PropertyPanel/TerminalDock/BottomComposer lazy-load levers above remain the reclamation path to bring this back down.

Combined-chunks limit raised 3.05->3.06 MB after adding the standalone Mermaid doc editor (MermaidDocEditor: diagram + editable Y.Text source with mermaid highlighting) — it is lazy-loaded (main bundle unaffected, still under 460 kB) so the growth is a new lazy chunk, not eager weight; the mermaid renderer + codemirror-lang-mermaid grammar were already in the chunk graph (prop-editor + edit-modal), so the delta is the doc-editor glue only.

Raised again 3.06->3.07 MB when rebasing onto main during finalization — ~2 kB is concurrent main growth (main app bundle grew 456.8->458.1 kB from unrelated merges), not the mermaid editor.

Main app bundle limit raised 460→462 kB after the mermaid-doc Ask-AI-composer-clearing fix (78ff0e5) pushed eager weight to 460.33 kB (333 B over) — the BottomComposer lazy-load lever above remains the reclamation path.

Combined-chunks limit raised 3.07->3.08 MB after the terminal clickable-links feature (terminal-links + terminal-link-provider land in the already-lazy TerminalPanel chunk, not the eager bundle — main app stayed at 460.84 kB) plus concurrent main growth on rebase pushed the combined total 315 B over 3.07 MB; the TerminalDock lazy-load lever above remains the reclamation path.

Main app bundle limit raised 462→466 kB after merging main + the tree-view Show visibility feature: eager weight is the Show menu group across the tree-options popover / context menu, the shared visibility predicates, and the NotInSidebarIndicator (~1-2 kB), with the rest concurrent main growth absorbed across three catch-up merges (bundle measured 464.63 kB, 2.63 kB over); the PropertyPanel/TerminalDock/BottomComposer lazy-load levers above remain the reclamation path.

Combined-chunks limit raised 3.08->3.25 MB (measured 3.22 MB after merging main) for the ACP agent-threads feature (in-app threads + unified sessions dock): the thread-client/thread-event-model chain, ThreadView, and the dock UI are lazy chunks (TerminalSessionsHost, AgentBuildShowcase, AgentThreadClientBinder, and the desktop TerminalWindowApp are all React.lazy mounts, so the main bundle stays under its 466 kB limit at 458 kB), but the combined glob counts lazy chunks too, so the feature's total JS footprint lands here.

Main CSS limit raised 52->53 kB — merging the ACP dock/thread surfaces onto main's CSS accretion pushed global utilities to 52.86 kB (863 B over), no single bloat source and no lazy-load lever for global CSS.

Combined-chunks 3.25->3.35 MB and CSS 54->56 kB after merging main (markdownlint content rules, Themes, external-link-preview, in-app Report a bug, GitHub Copilot CLI) into the ACP-threads branch — the merged build measures 3.31 MB / 55 kB combining both feature sets (main app 469 kB, under its 476 kB limit); no single reclaimable source beyond the lazy-load levers above.

Combined-chunks 3.35->3.5 MB and CSS 56->57 kB after merging main's bun->pnpm (Node 24) toolchain migration into the ACP-threads branch — a fresh pnpm resolution floats several bundled deps to newer patches within their existing caret ranges (dep declarations unchanged, no duplicate versions), diffuse drift inherent to the package-manager swap with no single reclaimable source; measured 3.45 MB / 56.38 kB, main app stays 469 kB under its 482 kB limit.

Merged the in-app feedback form onto these post-toolchain limits: main-app 482->485 kB (feedback's only eager weight is the HelpPopover Provide-feedback entry + dialog shell; FeedbackForm and its zod/react-hook-form/attachment deps are lazy behind FeedbackFormDialog), CSS 57->59 kB (the form's globals.css utilities — .scroll-fade-x mask, .scrollbar-none, shimmer @utility/@keyframes — plus Tailwind accretion from FeedbackForm + the attachment card), combined 3.5->3.55 MB (the merged tree stacks main's ACP/toolchain features and the lazy FeedbackForm chunk — measured 3,465,453 B locally, ~3.51 MB projected in CI at the ~1.4% local->CI ratio, over the intermediate 3.5); CI size-limit verifies the true merged numbers.

Windows/Linux desktop port stacked on this: the win/linux-only AppMenubar (and its radix Menubar primitive) is lazy-loaded behind the app-menubar-gate predicate so web + macOS never download its chunk; the residual eager weight is the gate + lazy() glue plus the pty-capability gating in EditorPane/SettingsDialogShell, absorbed under the current limits with no reclaimable source beyond the pre-existing lazy-load levers above.

Combined-chunks limit raised 3.6->3.61 MB for the div/center align-wrapper rendering (div-align promoter + HtmlAlignBlock descriptor/renderer; measured 170 B over the combined budget, main bundle unaffected at 485 kB) — the PropertyPanel/TerminalDock/BottomComposer lazy-load levers above remain the reclamation path.
