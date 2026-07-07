#!/usr/bin/env bun
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Node, Project, type SourceFile, SyntaxKind } from 'ts-morph';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, '..', '..');
const SRC_ROOT = resolve(APP_ROOT, 'src');
const OUT_DIR = resolve(APP_ROOT, 'tmp', 'strings-audit');
const VIEWER_TEMPLATE = resolve(SCRIPT_DIR, 'viewer-template.html');

// JSX attribute names that carry user-facing copy. Conservative — extend with care.
const USER_FACING_ATTRS = new Set([
  'title',
  'placeholder',
  'aria-label',
  'ariaLabel',
  'aria-description',
  'ariaDescription',
  'aria-roledescription',
  'alt',
  'label',
  'description',
  'tooltip',
  'tooltipText',
  'message',
  'cta',
  'ctaLabel',
  'confirmLabel',
  'cancelLabel',
  'okLabel',
  'submitLabel',
  'buttonLabel',
  'actionLabel',
  'errorMessage',
  'emptyState',
  'emptyMessage',
  'emptyLabel',
  'helpText',
  'helperText',
  'hint',
  'heading',
  'subheading',
  'subtitle',
  'summary',
  'caption',
  'name', // some Radix triggers, FormField name, etc. — high signal but some FP
]);

// Callees whose first arg is a user-facing message.
const TOAST_CALLEES = new Set([
  'toast',
  'toast.success',
  'toast.error',
  'toast.warning',
  'toast.info',
  'toast.message',
  'toast.loading',
  'notify',
  'notifyError',
  'notifySuccess',
  'showError',
  'showSuccess',
  'showWarning',
  'showInfo',
  'showToast',
]);

// Reject obviously non-UI strings.
const REJECT_PATTERNS: RegExp[] = [
  /^https?:\/\//i,
  /^\/[a-z0-9_-]/i, // path-like
  /^[a-z]+:\/\//i, // protocol
  /^[a-z][a-z0-9-]*\.(tsx?|jsx?|css|svg|png|jpg|md|json|yml|yaml)$/i,
  /^[A-Z][A-Z0-9_]*$/, // SCREAMING_SNAKE
  /^[a-z][a-zA-Z0-9]*$/, // camelCase identifier with no spaces — likely a token, not copy
  /^#[0-9a-f]{3,8}$/i, // hex color
  /^\s*$/, // whitespace only
];

const MIN_DISPLAYABLE_LEN = 1;

// View bucketing — top-level path segment under src/, with a second segment when meaningful.
// Rules use the `/i` flag where lowercase + uppercase forms might both exist on
// disk (folders like `components/settings/` vs files like `components/Settings*.tsx`)
// so one rule covers both. Order is significant — first match wins, so the more-
// specific patterns come before the catchall `^components/` at the end.
const VIEW_GROUP_RULES: Array<[RegExp, string]> = [
  [/^components\/settings/i, 'Settings'],
  [/^components\/handoff/i, 'Handoff (Open in agent)'],
  [/^components\/OpenIn/, 'Handoff (Open in agent)'],
  [/^components\/sidebar/i, 'Sidebar'],
  [/^components\/file-tree/i, 'Sidebar / File Tree'],
  [/^components\/FileTree/, 'Sidebar / File Tree'],
  [/^components\/docpanel/i, 'DocPanel'],
  [/^components\/command-palette/i, 'Command Palette'],
  [/^components\/CommandPalette/, 'Command Palette'],
  [/^components\/auth/i, 'Auth'],
  [/^components\/AutoSync/, 'Auto-sync'],
  [/^components\/property-panel/i, 'Property Panel'],
  [/^components\/PropertyPanel/, 'Property Panel'],
  [/^components\/AddProperty/, 'Property Panel'],
  [/^components\/conflict/i, 'Conflict resolver'],
  [/^components\/Sync/, 'Sync status'],
  [/^components\/Activity/, 'Activity panel'],
  [/^components\/Asset/, 'Asset preview'],
  [/^components\/Help/, 'Help'],
  [/^components\/Theme/, 'Theme toggle'],
  [/^components\/Beta/, 'Beta badge'],
  [/^components\/Editor/, 'Editor chrome'],
  [/^components\/EmptyState/, 'Empty state'],
  [/^components\/onboarding/i, 'Onboarding'],
  [/^components\/project/i, 'Project switcher'],
  [/^components\/Navigator/, 'Project switcher'],
  [/^components\/Clone/, 'Clone dialog'],
  [/^components\/Delete/, 'Dialogs / Delete'],
  [/^components\/NewItem/, 'Dialogs / New item'],
  [/^components\/Seed/, 'Dialogs / Seed'],
  [/^components\/MCP/, 'MCP consent'],
  [/^components\/Mcp/, 'MCP consent'],
  [/^components\/Install/, 'Install Claude dialog'],
  [/^components\/InstallClaude/, 'Install Claude dialog'],
  [/^components\/ErrorBoundary/, 'Error boundaries'],
  [/^components\/Diff/, 'Diff viewer'],
  [/^components\/Find/, 'Find / Replace'],
  [/^components\/Presence/, 'Presence'],
  [/^components\/Agent/, 'Agent UI'],
  [/^components\/Tab/, 'Editor chrome / Tabs'],
  [/^components\/Toolbar/, 'Editor chrome / Toolbar'],
  [/^components\/Footer/, 'Editor chrome / Footer'],
  [/^components\/Header/, 'Editor chrome / Header'],
  [/^components\/Outline/, 'DocPanel / Outline'],
  [/^components\/Timeline/, 'DocPanel / Timeline'],
  [/^components\/Links/, 'DocPanel / Links'],
  [/^components\/Backlink/, 'DocPanel / Backlinks'],
  [/^components\/Update/, 'Update notice'],
  [/^components\/Banner/, 'Banners'],
  [/^components\/Mount/, 'Banners'],
  [/^components\/Connecting/, 'Banners'],
  [/^components\/FileSidebar/, 'Sidebar'],
  [/^components\/CreateProject/, 'Project switcher'],
  [/^components\/Publish/, 'Publish to GitHub'],
  [/^components\/Consent/, 'MCP consent'],
  [/^components\/Share/, 'Share / Receive'],
  [/^components\/Frontmatter/, 'Property Panel'],
  [/^components\/Template/, 'Templates'],
  [/^components\/Graph/, 'DocPanel / Graph'],
  [/^components\/FolderProperties/, 'Settings'],
  [/^components\/Folder/, 'Folder overview'],
  [/^components\/EmptyEditor/, 'Empty state'],
  [/^components\/Empty/, 'Empty state'],
  [/^components\/ui\//, 'Primitives (shadcn)'],
  [/^components\//, 'Components (other)'],
  [/^editor\/slash-command\//, 'Editor / Slash command'],
  [/^editor\/bubble-menu\//, 'Editor / Bubble menu'],
  [/^editor\/block-ux\//, 'Editor / Block UX'],
  [/^editor\/clipboard\//, 'Editor / Clipboard'],
  [/^editor\/components\//, 'Editor / Components'],
  [/^editor\//, 'Editor (core)'],
  [/^hooks\//, 'Hooks'],
  [/^lib\//, 'Lib'],
  [/^server\//, 'Server (in-process)'],
  [/^presence\//, 'Presence'],
  [/^[^/]+\.tsx?$/, 'Root (App)'],
];

function deriveView(relPath: string): string {
  for (const [rx, name] of VIEW_GROUP_RULES) {
    if (rx.test(relPath)) return name;
  }
  return 'Unclassified';
}

type Occurrence = {
  file: string; // packages/app/src-relative
  view: string;
  line: number;
  column: number;
  kind: 'jsx-text' | 'jsx-attr' | 'toast-arg' | 'jsx-attr-template';
  attr?: string;
  callee?: string;
  componentContext?: string; // nearest JSXElement / function name
};

type StringRecord = {
  value: string; // normalized for grouping (trim, collapse internal whitespace)
  displayValue: string; // first-seen raw value (for viewer)
  charCount: number; // characters of displayValue (visible)
  hasTemplate: boolean;
  occurrences: Occurrence[];
};

const records = new Map<string, StringRecord>();
const skippedExamples: string[] = [];

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isAcceptable(raw: string): { ok: boolean; reason?: string } {
  const trimmed = raw.trim();
  if (trimmed.length < MIN_DISPLAYABLE_LEN) return { ok: false, reason: 'empty' };
  for (const rx of REJECT_PATTERNS) {
    if (rx.test(trimmed)) return { ok: false, reason: rx.source };
  }
  // Require at least one letter or a space-separated phrase
  if (!/[A-Za-z]/.test(trimmed)) return { ok: false, reason: 'no-letters' };
  // Single token with no whitespace AND no apostrophes/spaces — probably a CSS class or identifier
  // (but allow short words like "OK", "Save" — they have letters; this is for things like
  // 'flex-1', 'px-2', etc.). We already filter most of those via REJECT_PATTERNS.
  if (/^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(trimmed)) return { ok: false, reason: 'kebab-token' };
  return { ok: true };
}

function record(raw: string, occ: Omit<Occurrence, 'view'>, view: string) {
  const verdict = isAcceptable(raw);
  if (!verdict.ok) {
    if (skippedExamples.length < 200)
      skippedExamples.push(`${verdict.reason}: ${raw.slice(0, 80)}`);
    return;
  }
  const key = normalize(raw);
  let rec = records.get(key);
  if (!rec) {
    rec = {
      value: key,
      displayValue: raw,
      charCount: key.length,
      hasTemplate: raw.includes('${'),
      occurrences: [],
    };
    records.set(key, rec);
  }
  rec.occurrences.push({ ...occ, view });
}

function findEnclosingComponent(node: Node): string | undefined {
  let cur: Node | undefined = node;
  while (cur) {
    if (cur.getKind() === SyntaxKind.FunctionDeclaration) {
      const name = (cur as any).getName?.();
      if (name) return name;
    }
    if (cur.getKind() === SyntaxKind.VariableDeclaration) {
      const name = (cur as any).getName?.();
      if (name && /^[A-Z]/.test(name)) return name;
    }
    if (
      cur.getKind() === SyntaxKind.JsxOpeningElement ||
      cur.getKind() === SyntaxKind.JsxSelfClosingElement
    ) {
      const tagNameNode = (cur as any).getTagNameNode?.();
      const text = tagNameNode?.getText?.();
      if (text && /^[A-Z]/.test(text)) return text;
    }
    cur = cur.getParent();
  }
  return undefined;
}

function extractFromTemplate(node: Node): string {
  // Return a placeholder-normalized form: `Failed to load ${...}` becomes `Failed to load ${...}`
  // (we keep `${...}` so audit reviewers can see template shapes).
  const raw = node.getText();
  // Strip outer backticks
  if (raw.startsWith('`') && raw.endsWith('`')) {
    return raw.slice(1, -1).replace(/\$\{[^}]+\}/g, '${...}');
  }
  return raw;
}

function visitFile(sf: SourceFile, relPath: string, relForView: string) {
  const view = deriveView(relForView);

  sf.forEachDescendant((node) => {
    const kind = node.getKind();

    // JSX text
    if (kind === SyntaxKind.JsxText) {
      const text = (node as any).getLiteralText?.() ?? node.getText();
      if (!text.trim()) return;
      const start = sf.getLineAndColumnAtPos(node.getStart());
      record(
        text,
        {
          file: relPath,
          line: start.line,
          column: start.column,
          kind: 'jsx-text',
          componentContext: findEnclosingComponent(node),
        },
        view,
      );
      return;
    }

    // JSX attributes
    if (kind === SyntaxKind.JsxAttribute) {
      const attr = node as any;
      const name = attr.getNameNode()?.getText();
      if (!name || !USER_FACING_ATTRS.has(name)) return;
      const init = attr.getInitializer();
      if (!init) return;

      // Plain string literal: foo="bar"
      if (init.getKind() === SyntaxKind.StringLiteral) {
        const val = init.getLiteralText();
        const start = sf.getLineAndColumnAtPos(init.getStart());
        record(
          val,
          {
            file: relPath,
            line: start.line,
            column: start.column,
            kind: 'jsx-attr',
            attr: name,
            componentContext: findEnclosingComponent(node),
          },
          view,
        );
        return;
      }

      // Expression: foo={...} — pick up bare string literal and template w/o expressions
      if (init.getKind() === SyntaxKind.JsxExpression) {
        const exprNode = init.getExpression?.();
        if (!exprNode) return;
        const ek = exprNode.getKind();
        if (ek === SyntaxKind.StringLiteral) {
          const val = exprNode.getLiteralText();
          const start = sf.getLineAndColumnAtPos(exprNode.getStart());
          record(
            val,
            {
              file: relPath,
              line: start.line,
              column: start.column,
              kind: 'jsx-attr',
              attr: name,
              componentContext: findEnclosingComponent(node),
            },
            view,
          );
        } else if (ek === SyntaxKind.NoSubstitutionTemplateLiteral) {
          const val = (exprNode as any).getLiteralText();
          const start = sf.getLineAndColumnAtPos(exprNode.getStart());
          record(
            val,
            {
              file: relPath,
              line: start.line,
              column: start.column,
              kind: 'jsx-attr',
              attr: name,
              componentContext: findEnclosingComponent(node),
            },
            view,
          );
        } else if (ek === SyntaxKind.TemplateExpression) {
          const val = extractFromTemplate(exprNode);
          const start = sf.getLineAndColumnAtPos(exprNode.getStart());
          record(
            val,
            {
              file: relPath,
              line: start.line,
              column: start.column,
              kind: 'jsx-attr-template',
              attr: name,
              componentContext: findEnclosingComponent(node),
            },
            view,
          );
        }
      }
      return;
    }

    // JSX expression containing a string literal (e.g. <Foo>{"Save"}</Foo>) — rare but real
    if (kind === SyntaxKind.JsxExpression) {
      const parentKind = node.getParent()?.getKind();
      if (parentKind === SyntaxKind.JsxElement || parentKind === SyntaxKind.JsxFragment) {
        const inner = (node as any).getExpression?.();
        if (!inner) return;
        if (inner.getKind() === SyntaxKind.StringLiteral) {
          const val = inner.getLiteralText();
          const start = sf.getLineAndColumnAtPos(inner.getStart());
          record(
            val,
            {
              file: relPath,
              line: start.line,
              column: start.column,
              kind: 'jsx-text',
              componentContext: findEnclosingComponent(node),
            },
            view,
          );
        } else if (inner.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
          const val = (inner as any).getLiteralText();
          const start = sf.getLineAndColumnAtPos(inner.getStart());
          record(
            val,
            {
              file: relPath,
              line: start.line,
              column: start.column,
              kind: 'jsx-text',
              componentContext: findEnclosingComponent(node),
            },
            view,
          );
        } else if (inner.getKind() === SyntaxKind.TemplateExpression) {
          const val = extractFromTemplate(inner);
          const start = sf.getLineAndColumnAtPos(inner.getStart());
          record(
            val,
            {
              file: relPath,
              line: start.line,
              column: start.column,
              kind: 'jsx-attr-template',
              componentContext: findEnclosingComponent(node),
            },
            view,
          );
        }
      }
      return;
    }

    // Toast / notify / showError calls
    if (kind === SyntaxKind.CallExpression) {
      const call = node as any;
      const expr = call.getExpression();
      const callee = expr.getText();
      if (!TOAST_CALLEES.has(callee)) return;
      const args = call.getArguments();
      if (!args.length) return;
      const first = args[0];
      const k = first.getKind();
      if (k === SyntaxKind.StringLiteral) {
        const val = first.getLiteralText();
        const start = sf.getLineAndColumnAtPos(first.getStart());
        record(
          val,
          {
            file: relPath,
            line: start.line,
            column: start.column,
            kind: 'toast-arg',
            callee,
            componentContext: findEnclosingComponent(node),
          },
          view,
        );
      } else if (k === SyntaxKind.NoSubstitutionTemplateLiteral) {
        const val = first.getLiteralText();
        const start = sf.getLineAndColumnAtPos(first.getStart());
        record(
          val,
          {
            file: relPath,
            line: start.line,
            column: start.column,
            kind: 'toast-arg',
            callee,
            componentContext: findEnclosingComponent(node),
          },
          view,
        );
      } else if (k === SyntaxKind.TemplateExpression) {
        const val = extractFromTemplate(first);
        const start = sf.getLineAndColumnAtPos(first.getStart());
        record(
          val,
          {
            file: relPath,
            line: start.line,
            column: start.column,
            kind: 'toast-arg',
            callee,
            componentContext: findEnclosingComponent(node),
          },
          view,
        );
      }
    }
  });
}

console.error(`[audit-strings] scanning ${SRC_ROOT}`);
const t0 = Date.now();
const project = new Project({
  tsConfigFilePath: resolve(APP_ROOT, 'tsconfig.json'),
  skipAddingFilesFromTsConfig: true,
});

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === 'build' ||
      entry.name === 'tmp'
    )
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile()) {
      if (!/\.(tsx?|jsx?)$/.test(entry.name)) continue;
      if (/\.(test|dom\.test|integration\.test)\.(tsx?|jsx?)$/.test(entry.name)) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC_ROOT);
console.error(`[audit-strings] ${files.length} candidate files`);

for (const f of files) {
  project.addSourceFileAtPath(f);
}

let scanned = 0;
for (const sf of project.getSourceFiles()) {
  const rel = relative(resolve(APP_ROOT, '..'), sf.getFilePath()); // packages/app/src/...
  const relForView = relative(SRC_ROOT, sf.getFilePath());
  try {
    visitFile(sf, rel, relForView);
  } catch (e) {
    console.error(`[audit-strings] failed on ${rel}:`, (e as Error).message);
  }
  scanned++;
}

console.error(`[audit-strings] scanned ${scanned} files in ${Date.now() - t0}ms`);

// Build stats
const stringList = Array.from(records.values());

const byView = new Map<
  string,
  { uniqueStrings: Set<string>; occurrences: number; chars: number; files: Set<string> }
>();
for (const rec of stringList) {
  for (const occ of rec.occurrences) {
    let v = byView.get(occ.view);
    if (!v) {
      v = { uniqueStrings: new Set(), occurrences: 0, chars: 0, files: new Set() };
      byView.set(occ.view, v);
    }
    v.uniqueStrings.add(rec.value);
    v.occurrences += 1;
    v.chars += rec.charCount;
    v.files.add(occ.file);
  }
}

const totalUnique = stringList.length;
const totalOccurrences = stringList.reduce((n, r) => n + r.occurrences.length, 0);
const uniqueChars = stringList.reduce((n, r) => n + r.charCount, 0);
const weightedChars = stringList.reduce((n, r) => n + r.charCount * r.occurrences.length, 0);
const repeatedStrings = stringList.filter((r) => r.occurrences.length >= 2);
const repeatedAcrossViews = stringList.filter(
  (r) => new Set(r.occurrences.map((o) => o.view)).size >= 2,
);

stringList.sort((a, b) => b.occurrences.length - a.occurrences.length || b.charCount - a.charCount);

const catalog = {
  generatedAt: new Date().toISOString(),
  srcRoot: relative(resolve(APP_ROOT, '..'), SRC_ROOT),
  // Absolute path that, when joined with each occurrence's `file`, yields the
  // absolute filesystem path — viewer uses this to build cursor:// URLs.
  fileBaseAbsolute: resolve(APP_ROOT, '..'),
  fileCount: scanned,
  attrAllowlist: Array.from(USER_FACING_ATTRS).sort(),
  calleeAllowlist: Array.from(TOAST_CALLEES).sort(),
  stats: {
    uniqueStrings: totalUnique,
    totalOccurrences,
    uniqueChars,
    weightedChars,
    repeatedStringCount: repeatedStrings.length,
    crossViewRepeatedCount: repeatedAcrossViews.length,
    byView: Object.fromEntries(
      Array.from(byView.entries())
        .map(([name, v]) => [
          name,
          {
            uniqueStrings: v.uniqueStrings.size,
            totalOccurrences: v.occurrences,
            totalChars: v.chars,
            fileCount: v.files.size,
          },
        ])
        .sort((a, b) => (b[1] as any).totalOccurrences - (a[1] as any).totalOccurrences),
    ),
  },
  strings: stringList.map((r) => ({
    value: r.value,
    displayValue: r.displayValue,
    charCount: r.charCount,
    hasTemplate: r.hasTemplate,
    occurrenceCount: r.occurrences.length,
    uniqueViewCount: new Set(r.occurrences.map((o) => o.view)).size,
    views: Array.from(new Set(r.occurrences.map((o) => o.view))).sort(),
    occurrences: r.occurrences,
  })),
  skippedExamples: skippedExamples.slice(0, 50),
};

mkdirSync(OUT_DIR, { recursive: true });
const catalogPath = join(OUT_DIR, 'catalog.json');
writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
console.error(`[audit-strings] wrote ${catalogPath}`);

// Emit viewer.html with embedded data
let template: string;
try {
  template = readFileSync(VIEWER_TEMPLATE, 'utf8');
} catch {
  console.error(`[audit-strings] no viewer template at ${VIEWER_TEMPLATE} — skipping viewer emit`);
  process.exit(0);
}
const viewerHtml = template.replace(
  '/*__CATALOG_DATA__*/null',
  JSON.stringify(catalog).replace(/<\/script>/g, '<\\/script>'),
);
const viewerPath = join(OUT_DIR, 'index.html');
writeFileSync(viewerPath, viewerHtml);
console.error(`[audit-strings] wrote ${viewerPath}`);

console.error(`
=== summary ===
unique strings:      ${totalUnique}
total occurrences:   ${totalOccurrences}
unique chars:        ${uniqueChars}
weighted chars:      ${weightedChars}
repeated strings:    ${repeatedStrings.length}
cross-view repeats:  ${repeatedAcrossViews.length}
view buckets:        ${byView.size}
`);
