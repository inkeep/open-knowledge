---
title: Core Concepts
icon: LuLightbulb
description: "How OpenKnowledge works: the three-layer model, the file system as the database, links and backlinks, the well-connected knowledge base, and attribution."
---

This page is the precise reference for the ideas the rest of the docs build on. If you want the persuasive tour instead, start with the [Overview](../get-started/overview.mdx); if you want to start using it, see the [Quickstart](../get-started/quickstart.mdx).

## Three layers

OpenKnowledge has three layers working together:
- a surface you edit
- an engine that keeps it consistent
- the files underneath

```html preview
<div style="padding:18px">
  <div class="tl-surfaces" id="surf"></div>
  <div class="tl-arrows">↓&nbsp;&nbsp;&nbsp;↓&nbsp;&nbsp;&nbsp;↓</div>
  <div class="tl-files" id="files">
    <div class="tl-files-t">your-project/ &middot; *.md</div>
    <div class="tl-files-s">plain markdown, versioned by git</div>
  </div>
  <div class="cap">All three operate on the same files. Nothing locks you out.</div>
</div>
<style>
#surf{display:flex;flex-wrap:wrap;gap:8px}
#surf .s{flex:1;min-width:132px;border:1px solid var(--border);border-radius:12px;padding:11px 13px;background:var(--card);transition:border-color .3s,box-shadow .3s;cursor:pointer}
#surf .s .t{font-weight:600;font-size:13px}
#surf .s .d{color:var(--muted-foreground);font-size:11.5px;margin-top:2px}
#surf .s.on{border-color:var(--primary);box-shadow:0 0 0 3px var(--accent-soft)}
#surf .s.on .t{color:var(--accent-ink)}
.tl-arrows{text-align:center;color:var(--muted-foreground);font-size:15px;margin:9px 0}
.tl-files{border:1px dashed var(--border);border-radius:12px;padding:12px 14px;background:var(--card);text-align:center;transition:border-color .3s,box-shadow .3s}
.tl-files.on{border-color:var(--primary);border-style:solid;box-shadow:0 0 0 3px var(--accent-soft)}
.tl-files-t{font:600 13px ui-monospace,monospace}
.tl-files-s{color:var(--muted-foreground);font-size:11.5px;margin-top:2px}
.cap{margin-top:12px;color:var(--muted-foreground);font-size:12.5px}
@media (prefers-reduced-motion:reduce){#surf .s,.tl-files{transition:none}}
</style>
<script>
var data=[["The editor","WYSIWYG markdown, in the app"],["The knowledge engine","any AI agent, over MCP"],["Any text editor","by hand, whenever"]];
var surf=document.getElementById("surf"),files=document.getElementById("files"),nodes=[];
data.forEach(function(s,i){
  var d=document.createElement("div");d.className="s";
  var t=document.createElement("div");t.className="t";t.textContent=s[0];
  var sub=document.createElement("div");sub.className="d";sub.textContent=s[1];
  d.appendChild(t);d.appendChild(sub);
  d.onclick=function(){pinned=true;set(i);};
  surf.appendChild(d);nodes.push(d);
});
var cur=0,pinned=false;
function set(i){cur=i;nodes.forEach(function(n,j){n.classList.toggle("on",j===i);});files.classList.add("on");setTimeout(function(){files.classList.remove("on");},650);}
set(0);
if(!matchMedia("(prefers-reduced-motion:reduce)").matches){setInterval(function(){if(!pinned)set((cur+1)%nodes.length);},1600);}
</script>
```

<Cards>
  <Card title="The editor" href="../features/editor.mdx">
    The application you see: a beautiful, themeable markdown editor that renders rich extensions (Mermaid, LaTeX, video and asset embeds, callouts, collapsible sections, interactive HTML) and lets you read and write your knowledge base directly.
  </Card>
  <Card title="The knowledge engine" href="./mcp.mdx">
    The framework underneath: an MCP server that lets any AI agent read and write your knowledge base while keeping front matter consistent, references intact, and the link graph healthy.
  </Card>
  <Card title="The content" href="#the-file-system-is-the-database">
    The files underneath: plain markdown in your own project directory, version-controlled by git. This is the durable layer the other two operate on, described in detail below.
  </Card>
</Cards>

All three layers operate on the **same files**. You can edit through the editor, an agent can edit through the knowledge engine's MCP tools, and you can always drop down to any text editor and change the markdown by hand. Nothing locks you out.

Because the knowledge engine is exposed over [MCP](https://modelcontextprotocol.io), it is **agent-agnostic**. Bring Claude Code, Cursor, Codex, OpenCode, Gemini, or any MCP-capable client, and any model you have access to.

## The file system is the database

The third layer is the content itself. OpenKnowledge has **no database dependency**. Your knowledge base is plain markdown files in your own project directory, and the only persistence layer is the file system, version-controlled by git.

This means:

- **No lock-in.** Your knowledge is portable markdown you can read, grep, diff, and commit with ordinary tools.
- **Almost nothing to install.** The recommended path is the macOS app; there is no separate database or service to run.
- **The engine is a management layer, not a gatekeeper.** It maintains consistency when you go through it, but editing the raw files yourself is always allowed.

The set of files the engine treats as your knowledge base is the configured content directory. See [Configuration](./configuration.mdx) for where that and other settings live.

## Links and backlinks

Internal cross-references are written with **standard markdown links**. The recommended form is **relative** — `[text](./sibling.md)`, `[text](../folder/doc.md)` — which stays portable across GitHub, Obsidian, VS Code, and published sites. A **root-absolute** form (`[text](/folder/doc.md)`, where the leading slash means the content root) is equally valid and convenient for cross-folder links. The two never mix: never glue `./` onto a content-root path, since `./folder/doc.md` written from a doc already inside `folder/` resolves to the doubled, broken `folder/folder/doc.md` — `write`/`edit` flag exactly this in their `brokenLinks` response. Whenever document A links to document B, OpenKnowledge automatically records the inverse on B: a **backlink** from B back to A.

You never write backlinks by hand. They are computed from the links you already write, and together they form the **link graph**: the network of relationships across your knowledge base.

```html preview
<div style="padding:18px">
  <div id="lb"></div>
  <div class="cap">Write the link once; OpenKnowledge records the backlink on the target for you.</div>
</div>
<style>
#lb{display:flex;flex-wrap:wrap;gap:10px;align-items:stretch}
#lb .card{flex:1;min-width:150px;border:1px solid var(--border);border-radius:12px;padding:12px 13px;background:var(--card)}
#lb .card .t{font:600 12.5px ui-monospace,monospace}
#lb .row{font-size:12px;margin-top:8px;color:var(--muted-foreground);opacity:0;transform:translateY(3px);transition:opacity .4s,transform .4s}
#lb .row.on{opacity:1;transform:none}
#lb .row .k{color:var(--accent-ink);font-weight:600}
#lb .mid{align-self:center;color:var(--muted-foreground);font-size:12px;text-align:center;min-width:104px}
#lb .mid .b{margin-top:6px;opacity:0;transform:translateY(3px);transition:opacity .4s,transform .4s}
#lb .mid .b.on{opacity:1;transform:none;color:var(--primary);font-weight:600}
.cap{margin-top:12px;color:var(--muted-foreground);font-size:12.5px}
@media (prefers-reduced-motion:reduce){#lb .row,#lb .mid .b{transition:none}}
</style>
<script>
document.getElementById("lb").innerHTML=
  '<div class="card"><div class="t">login.md</div><div class="row on"><span class="k">link &rarr;</span> [Sessions](./sessions.md)</div></div>'
 +'<div class="mid"><div>you write<br>one link</div><div class="b" id="b">&#x21A9; inverse recorded</div></div>'
 +'<div class="card"><div class="t">sessions.md</div><div class="row" id="bkrow"><span class="k">backlink &larr;</span> login.md</div></div>';
var b=document.getElementById("b"),bk=document.getElementById("bkrow");
function cycle(){b.classList.remove("on");bk.classList.remove("on");setTimeout(function(){b.classList.add("on");},500);setTimeout(function(){bk.classList.add("on");},900);}
cycle();
if(!matchMedia("(prefers-reduced-motion:reduce)").matches)setInterval(cycle,3200);
</script>
```

<Callout type="info">
  Backlinks are the payoff of ordinary linking. Every internal link you write earns a backlink on the target for free, so the graph grows as a side effect of normal writing.
</Callout>

## The well-connected knowledge base

"Well-connected" is not a vibe; it has concrete substance:

> **A well-connected knowledge base = backlinks + the link-graph tools (dead / orphans / hubs / suggest) + closed-loop grounding.**

An agent puts all three to work when it retrieves: it searches, greps, and follows backlinks in a loop over your live files, with no vector database. That mechanism is [Agentic search](./agentic-search.mdx).

### Backlinks

The automatic inverse relationships described above. They turn a pile of files into a navigable graph.

### The link-graph tools

The knowledge engine exposes a [`links`](./mcp.mdx) tool whose `kind` selects a view of the graph. Four of these views are how you keep the graph healthy:

| View | What it surfaces |
| --- | --- |
| `dead` | Links that point at documents that don't exist: broken references to fix or remove. |
| `orphans` | Documents nothing links to: knowledge that's effectively unreachable. |
| `hubs` | The most-linked-to documents: the natural centers of gravity in your KB. |
| `suggest` | Likely-missing links between related documents: connections worth adding. |

Agents use these to repair and densify the graph as they work, instead of letting it rot.

```html preview
<div style="padding:18px">
  <div id="gt-tabs" class="gt-tabs"></div>
  <div id="gt-nodes" class="gt-nodes"></div>
  <div id="gt-cap" class="cap"></div>
</div>
<style>
.gt-tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.gt-tabs .tab{font:600 11.5px ui-monospace,monospace;border:1px solid var(--border);border-radius:999px;padding:4px 11px;background:var(--card);color:var(--muted-foreground);cursor:pointer;transition:border-color .3s,background .3s,color .3s}
.gt-tabs .tab.on{border-color:var(--primary);background:var(--accent-soft);color:var(--accent-ink)}
.gt-nodes{display:flex;flex-wrap:wrap;gap:8px}
.gt-nodes .n{border:1px solid var(--border);border-radius:10px;padding:8px 11px;background:var(--card);font:12.5px ui-monospace,monospace;color:var(--muted-foreground);transition:border-color .3s,box-shadow .3s,color .3s}
.gt-nodes .n.hot{border-color:var(--primary);box-shadow:0 0 0 3px var(--accent-soft);color:var(--accent-ink)}
.gt-nodes .n .tag{display:block;font:11px system-ui;margin-top:2px;color:var(--primary)}
.cap{margin-top:12px;color:var(--muted-foreground);font-size:12.5px;min-height:1.2em}
@media (prefers-reduced-motion:reduce){.gt-tabs .tab,.gt-nodes .n{transition:none}}
</style>
<script>
var nodes=["README.md","auth.md","tokens.md","draft.md","old-notes.md"];
var views=[
 {k:"dead",hot:{1:"&rarr; missing.md &#x2717;"},cap:"dead: links pointing at documents that don't exist."},
 {k:"orphans",hot:{3:"nothing links here"},cap:"orphans: documents nothing links to."},
 {k:"hubs",hot:{0:"most linked-to"},cap:"hubs: the natural centers of gravity."},
 {k:"suggest",hot:{1:"relates &rarr; tokens.md",2:"relates &rarr; auth.md"},cap:"suggest: likely-missing links worth adding."}
];
var tabsEl=document.getElementById("gt-tabs"),nodesEl=document.getElementById("gt-nodes"),capEl=document.getElementById("gt-cap"),tabs=[];
views.forEach(function(v,i){var t=document.createElement("div");t.className="tab";t.textContent=v.k;t.onclick=function(){pinned=true;set(i);};tabsEl.appendChild(t);tabs.push(t);});
function set(i){var v=views[i];tabs.forEach(function(t,j){t.classList.toggle("on",j===i);});nodesEl.innerHTML=nodes.map(function(n,j){var tag=v.hot[j]?'<span class="tag">'+v.hot[j]+'</span>':'';return '<div class="n'+(v.hot[j]?' hot':'')+'">'+n+tag+'</div>';}).join("");capEl.innerHTML=v.cap;}
var cur=0,pinned=false;set(0);
if(!matchMedia("(prefers-reduced-motion:reduce)").matches)setInterval(function(){if(!pinned){cur=(cur+1)%views.length;set(cur);}},2400);
</script>
```

### Closed-loop grounding

Every factual claim should trace back to a source **inside** the knowledge base. External material is pulled in and cited locally rather than linked off to the open web, so the knowledge base stays self-contained and auditable. This is the backbone of the source-grounded workflows: see the [LLM wiki workflow](../workflows/karpathy-llm-wiki.mdx) and the [Entity vault (GBrain-compatible) workflow](../workflows/entity-vault.mdx).

<Callout type="info">
  OpenKnowledge is unopinionated about which workflow you adopt; these are supported patterns, not requirements. Grounding, backlinks, and the graph tools work the same regardless of how you choose to organize.
</Callout>

## Attribution and collaboration

Every change made through OpenKnowledge is tracked, with **attribution** to whoever made it: a human author or a specific AI agent. The change history is persisted in the file system with no dependency beyond git.

```html preview
<div style="padding:18px">
  <div id="attr"></div>
  <div class="cap">Every edit is attributed — a human or a specific agent — and revertible, with nothing beyond git.</div>
</div>
<style>
#attr{display:flex;flex-direction:column;gap:6px}
#attr .e{display:flex;align-items:center;gap:10px;border:1px solid var(--border);border-radius:10px;padding:9px 12px;background:var(--card);transition:border-color .3s,box-shadow .3s}
#attr .e.on{border-color:var(--primary);box-shadow:0 0 0 3px var(--accent-soft)}
#attr .who{font:600 11px ui-monospace,monospace;border-radius:999px;padding:2px 9px;white-space:nowrap}
#attr .who.h{background:var(--accent-soft);color:var(--accent-ink)}
#attr .who.a{border:1px solid var(--border);color:var(--muted-foreground)}
#attr .sha{font:11.5px ui-monospace,monospace;color:var(--muted-foreground)}
#attr .msg{font-size:12.5px}
.cap{margin-top:12px;color:var(--muted-foreground);font-size:12.5px}
@media (prefers-reduced-motion:reduce){#attr .e{transition:none}}
</style>
<script>
var log=[
 ["a","agent:claude","9f8e7d6","Drafted the overview"],
 ["h","you","a1b2c3d","Fixed the token-refresh race"],
 ["a","agent:cursor","4d5e6f7","Linked auth.md &rarr; tokens.md"],
 ["h","you","b7c8d9e","Promoted to canonical"]
];
document.getElementById("attr").innerHTML=log.map(function(r){return '<div class="e"><span class="who '+r[0]+'">'+r[1]+'</span><span class="sha">'+r[2]+'</span><span class="msg">'+r[3]+'</span></div>';}).join("");
var rows=document.getElementById("attr").querySelectorAll(".e"),cur=0;
function tick(){rows.forEach(function(x,j){x.classList.toggle("on",j===cur);});cur=(cur+1)%rows.length;}
tick();
if(!matchMedia("(prefers-reduced-motion:reduce)").matches)setInterval(tick,1600);
</script>
```

That gives you:

- **A changelog** of every edit across the knowledge base.
- **Point-in-time history.** Revert to any earlier state.
- **Per-author views.** See exactly what one human or one agent changed.

Because humans and agents edit the same files through the same tracked layer, collaboration is a first-class property of the system rather than something bolted on.
