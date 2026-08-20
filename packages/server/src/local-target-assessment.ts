/**
 * Assess extracted local-target occurrences against one content-scoped
 * inventory: resolve each to a canonical project identity, decide whether that
 * identity exists, and record how the answer was reached.
 *
 * Recognition and positioning are upstream (`local-target-occurrences.ts`); this
 * layer owns resolution, classification, and existence. Exact project-local
 * existence is authoritative — an occurrence is `exact` only when its authored
 * path resolves exactly to an existing target. Tolerant navigation (slug /
 * basename / folder-index, computed elsewhere) is offered through the optional
 * inventory oracle and recorded as `fallback`, never blessed as `exact`, so a
 * mistyped path that merely happens to be navigable is not silently validated.
 *
 * The inventory is injected because document membership and ordinary-file
 * membership live in different places (an in-memory admitted-doc set vs the
 * watcher's all-files inventory) and both stay behind `ContentFilter` and
 * symlink/alias identity in the concrete implementation. This module is pure
 * over that interface.
 *
 * EVERY recognized form is assessed, wiki included. Recognition is consolidated
 * behind one grammar, so an occurrence the extractor sees is one some surface
 * will report on, and a form this layer refuses to answer for is a hole that
 * surface fills by guessing — which is how reporting planes come to disagree
 * about the same authored link. Classification is therefore total.
 *
 * What reaches a given SURFACE is a separate, narrower question, answered at the
 * projection boundary below (`toForwardLinkLocalTargets`,
 * `buildLocalTargetEvidence`): wiki document links are graph edges the
 * `forwardLinks` union already carries, and file-shaped wiki embeds resolve by
 * vault-wide basename under their own contract, so neither projects onto the
 * local-target wire surfaces. Classify everything; project selectively.
 */

import {
  assertNeverLinkTarget,
  type BrokenLinkReason,
  classifyMarkdownHref,
  classifyWikiLinkTarget,
  type ForwardLinkLocalTarget,
  type LocalTargetDiagnosticEvidence,
  type LocalTargetSourceForm,
  resolveAssetProjectPath,
  toWikiLinkSlug,
} from '@inkeep/open-knowledge-core';
import {
  extractLocalTargetOccurrences,
  type LocalTargetOccurrence,
  type OccurrenceSourceForm,
} from './local-target-occurrences.ts';

/**
 * What a target resolves to on disk. `image` and `link` are the occurrence
 * ROLE, not a kind — an image resolves to a `file`. `unknown` is a target with
 * no derivable project identity (an escaping or unsupported path).
 */
type LocalTargetKind = 'document' | 'file' | 'unknown';

/**
 * Outcome of assessing one occurrence against the inventory.
 * - `exact` — the authored path resolves exactly to an existing target.
 * - `fallback` — the authored path is not an exact hit, but tolerant navigation
 *   reaches an existing target; the authored path is NOT blessed as valid.
 * - `missing` — resolves to a canonical identity that does not exist.
 * - `unresolvable` — cannot resolve to any project identity (root escape, empty,
 *   or unsupported relative form).
 */
type LocalTargetStatus = 'exact' | 'fallback' | 'missing' | 'unresolvable';

/**
 * Failure reason for an unresolved target, aligned with core's
 * `BrokenLinkReason`. Null when the target resolves (`exact`); present for
 * `fallback` too, because a fallback still means the authored path was broken.
 */
type LocalTargetReason = 'no-such-doc' | 'no-such-file' | 'unresolvable';

/**
 * How the canonical identity (or the fallback) was derived. Resolution
 * provenance keeps a tolerant hit distinguishable from an exact one, so strict
 * audit and tolerant navigation can never silently disagree.
 */
type LocalTargetResolutionMethod = 'source-relative' | 'root-relative' | 'tolerant' | 'none';

/**
 * Content-scoped existence oracle. The concrete implementation composes the
 * admitted-document set with the watcher's all-files inventory behind
 * `ContentFilter` and realpath/alias identity; this contract exposes only the
 * two membership questions the assessment asks.
 */
export interface LocalTargetInventory {
  /** Whether an extension-less, content-root-relative docName is an admitted live document. */
  hasDocument(docName: string): boolean;
  /** Whether an extension-bearing, content-root-relative file path is an admitted ordinary file. */
  hasFile(contentRootRelativePath: string): boolean;
  /**
   * Optional tolerant-navigation resolver: when the exact docName is absent,
   * return an existing docName reachable by tolerant navigation, or null. Used
   * only to record `fallback` provenance — never to mark a wrong authored path
   * `exact`.
   */
  resolveTolerantDocument?(docName: string, sourceDocName: string): string | null;
  /**
   * Optional folder-existence oracle: whether an extension-less path names an
   * existing content folder (an ancestor of at least one admitted document —
   * the same derivation every navigating surface uses). An existing folder is
   * a real destination since the folder-links fix (it opens the folder view at
   * `#/<folderPath>`), so `assessDocument` reports it `exact` instead of
   * minting a dead-link finding. Absent oracle = folders unknown, which
   * preserves the pre-folder behavior for callers that never see folders.
   */
  hasFolder?(folderPath: string): boolean;
}

/** Build the deterministic tolerant document lookup shared by index and write-time assessment. */
export function createTolerantDocumentResolver(
  documentNames: Iterable<string>,
): (docName: string) => string | null {
  const documents = new Set(documentNames);
  const bySlug = new Map<string, string>();
  for (const docName of documents) {
    const slug = toWikiLinkSlug(docName);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, docName);
  }
  const byBasename = new Map<string, string>();
  for (const docName of [...documents].sort((a, b) => a.localeCompare(b))) {
    const leaf = docName.slice(docName.lastIndexOf('/') + 1);
    const slug = toWikiLinkSlug(leaf);
    if (slug && !byBasename.has(slug)) byBasename.set(slug, docName);
  }
  return (docName) => {
    const slug = toWikiLinkSlug(docName);
    const slugMatch = slug ? bySlug.get(slug) : undefined;
    if (slugMatch) return slugMatch;
    const canonicalIndex = `${docName}/index`;
    if (documents.has(canonicalIndex)) return canonicalIndex;
    const leaf = docName.slice(docName.lastIndexOf('/') + 1);
    const legacyFolderNote = `${docName}/${leaf}`;
    if (documents.has(legacyFolderNote)) return legacyFolderNote;
    if (!docName.includes('/') && slug) return byBasename.get(slug) ?? null;
    return null;
  };
}

export interface LocalTargetAssessment {
  /** The occurrence this assesses — carries role, source form, authored href, and exact range. */
  occurrence: LocalTargetOccurrence;
  targetKind: LocalTargetKind;
  /**
   * Canonical project identity the AUTHORED href resolves to (docName for a
   * document, content-root-relative path for a file), or null when unresolvable.
   * For `missing`/`fallback` this is the identity that does not exist; for
   * `exact` it exists.
   */
  resolvedTarget: string | null;
  status: LocalTargetStatus;
  /** Failure reason for `missing`/`fallback`/`unresolvable`; null for `exact`. */
  reason: LocalTargetReason | null;
  resolutionMethod: LocalTargetResolutionMethod;
  /**
   * For `fallback` only: the existing target tolerant navigation reaches.
   * Distinct from `resolvedTarget` (the authored, non-existent identity) so a
   * wrong authored path is never presented as exact. Null otherwise.
   */
  fallbackTarget: string | null;
}

/** Everything in an assessment except the per-occurrence identity — shared across occurrences with the same href. */
type SharedAssessment = Omit<LocalTargetAssessment, 'occurrence'>;

/** A leading `/` is a content-root path; anything else resolves against the source doc's directory. */
function methodForHref(href: string): 'source-relative' | 'root-relative' {
  return href.trim().startsWith('/') ? 'root-relative' : 'source-relative';
}

const UNRESOLVABLE: SharedAssessment = {
  targetKind: 'unknown',
  resolvedTarget: null,
  status: 'unresolvable',
  reason: 'unresolvable',
  resolutionMethod: 'none',
  fallbackTarget: null,
};

function assessDocument(
  docName: string,
  href: string,
  sourceDocName: string,
  inventory: LocalTargetInventory,
  exactExists?: boolean,
): SharedAssessment {
  if (exactExists ?? inventory.hasDocument(docName)) {
    return {
      targetKind: 'document',
      resolvedTarget: docName,
      status: 'exact',
      reason: null,
      resolutionMethod: methodForHref(href),
      fallbackTarget: null,
    };
  }
  // An existing folder is an exact destination, not a missing document: every
  // navigating surface opens it as the folder view at `#/<folderPath>`.
  // Checked BEFORE tolerant fallback so a folder target keeps its
  // authored identity rather than being re-pointed at a lookalike doc; a
  // folder that also carries an index doc still navigates fine (the folder
  // view lists it). Checked AFTER the exact-document branch so a doc named
  // like a folder keeps winning.
  if (inventory.hasFolder?.(docName)) {
    return {
      targetKind: 'document',
      resolvedTarget: docName,
      status: 'exact',
      reason: null,
      resolutionMethod: methodForHref(href),
      fallbackTarget: null,
    };
  }
  const fallback = inventory.resolveTolerantDocument?.(docName, sourceDocName) ?? null;
  if (fallback) {
    return {
      targetKind: 'document',
      resolvedTarget: docName,
      status: 'fallback',
      reason: 'no-such-doc',
      resolutionMethod: 'tolerant',
      fallbackTarget: fallback,
    };
  }
  return {
    targetKind: 'document',
    resolvedTarget: docName,
    status: 'missing',
    reason: 'no-such-doc',
    resolutionMethod: methodForHref(href),
    fallbackTarget: null,
  };
}

function assessFile(
  assetUrl: string,
  href: string,
  sourceDocName: string,
  inventory: LocalTargetInventory,
  literal: boolean,
): SharedAssessment {
  const filePath = resolveAssetProjectPath(assetUrl, sourceDocName, { literal });
  if (filePath === null) {
    // `../` overshoot past the content root — no project-local path.
    return { ...UNRESOLVABLE, targetKind: 'file' };
  }
  if (inventory.hasFile(filePath)) {
    return {
      targetKind: 'file',
      resolvedTarget: filePath,
      status: 'exact',
      reason: null,
      resolutionMethod: methodForHref(href),
      fallbackTarget: null,
    };
  }
  // Ordinary files have no tolerant-navigation fallback (that affordance is
  // document-only), so an absent file is simply missing.
  return {
    targetKind: 'file',
    resolvedTarget: filePath,
    status: 'missing',
    reason: 'no-such-file',
    resolutionMethod: methodForHref(href),
    fallbackTarget: null,
  };
}

/**
 * Wiki forms resolve their target against the vault root, not the source doc.
 * Exhaustive so a new `OccurrenceSourceForm` member fails to compile here too,
 * not just in `diagnosticSourceForm` — a form routed through the wrong resolver
 * would type-check while resolving against the wrong base.
 */
function isWikiForm(sourceForm: OccurrenceSourceForm): boolean {
  switch (sourceForm) {
    case 'wiki-link':
    case 'wiki-embed':
      return true;
    case 'markdown-inline':
    case 'markdown-reference':
    case 'html-img':
      return false;
    default: {
      const unreachable: never = sourceForm;
      return unreachable;
    }
  }
}

/**
 * Resolve + assess one authored href. Returns null when the href is not a local
 * target at all (external / anchor) — upstream extraction already excludes those,
 * so this is a total-function branch, not a live path.
 */
function assessHref(
  href: string,
  role: LocalTargetOccurrence['role'],
  sourceForm: OccurrenceSourceForm,
  sourceDocName: string,
  inventory: LocalTargetInventory,
): SharedAssessment | null {
  // Wiki targets are vault-root-relative, not source-relative: `[[targets/x]]`
  // in `notes/index` names `targets/x`, not `notes/targets/x`. The document
  // graph has always resolved them with `classifyWikiLinkTarget`, so using the
  // markdown resolver here would make the two planes disagree about where the
  // same authored wiki link points — a fresh instance of the very divergence
  // this contract exists to close, and invisible from a root-level source doc
  // where the two resolutions coincide.
  const classified = isWikiForm(sourceForm)
    ? classifyWikiLinkTarget(href, null)
    : classifyMarkdownHref(href, sourceDocName);
  if (!classified) {
    // A local candidate that resolves to nothing: empty, root-escaping, or an
    // unsupported extension-less relative path.
    return UNRESOLVABLE;
  }
  switch (classified.kind) {
    case 'doc': {
      // Extension-less hrefs are syntactically ambiguous: links usually name
      // documents, while images always name files. Exact inventory membership
      // resolves that ambiguity without guessing from a filename extension.
      //
      // A wiki EMBED carries the image role but not the image meaning: `![[Note]]`
      // transcludes a document, and the canonical matrix expects an
      // extension-less embed to report as a missing DOCUMENT. So the role-based
      // shortcut is a markdown/HTML image rule, not a universal one — an
      // extension-bearing embed still classifies as a file through the `asset`
      // branch below, because `classifyMarkdownHref` never routes it here.
      if (role === 'image' && !isWikiForm(sourceForm)) {
        return assessFile(href, href, sourceDocName, inventory, false);
      }
      const documentExists = inventory.hasDocument(classified.docName);
      // The file fallback is markdown-only, and deliberately so. It resolves
      // SOURCE-relative, while a wiki target resolved vault-root-relative just
      // above — running it for a wiki form would answer one occurrence with two
      // different resolution origins. An extension-less wiki target is a
      // document by contract anyway: `[[Note]]` names a note, and an
      // extension-bearing one never reaches this branch.
      if (!documentExists && !isWikiForm(sourceForm)) {
        const file = assessFile(href, href, sourceDocName, inventory, false);
        if (file.status === 'exact') return file;
      }
      return assessDocument(classified.docName, href, sourceDocName, inventory, documentExists);
    }
    case 'asset':
      // Both classifiers emit the same `{kind: 'asset', url}` shape, so the
      // plane rides on the target's own `literal` tag rather than being
      // re-derived from `sourceForm` here. A wiki target names a file
      // literally: `![[100%20done.png]]` means a file whose name contains
      // `%20`, and decoding it would look for a different file and report a
      // false dead-link — the very symptom this resolver's decoding half fixes
      // on the markdown plane.
      return assessFile(classified.url, href, sourceDocName, inventory, classified.literal);
    case 'external':
    case 'anchor':
      return null;
    default:
      return assertNeverLinkTarget(classified);
  }
}

/**
 * Assess a document's occurrences, sharing existence work across repeated
 * href/role pairs. Because the source document is fixed, a pair resolves
 * identically every time, so its classification + inventory lookup is computed
 * once and reused; every occurrence still yields its own assessment carrying
 * its own range. Role is part of the key because an extension-less link may be
 * a document while an image with the same href must be a file.
 */
export function assessLocalTargetOccurrences(
  occurrences: readonly LocalTargetOccurrence[],
  sourceDocName: string,
  inventory: LocalTargetInventory,
): LocalTargetAssessment[] {
  // `undefined` = not computed yet; `null` = computed, not a local target.
  const sharedByHrefAndRole = new Map<string, SharedAssessment | null>();
  const assessments: LocalTargetAssessment[] = [];
  for (const occurrence of occurrences) {
    // Source form joins the key because an extension-less href resolves
    // differently per form: a wiki embed of it is document-shaped while a
    // markdown image of it is file-shaped.
    const cacheKey = `${occurrence.role}\0${occurrence.sourceForm}\0${occurrence.href}`;
    let shared = sharedByHrefAndRole.get(cacheKey);
    if (shared === undefined) {
      shared = assessHref(
        occurrence.href,
        occurrence.role,
        occurrence.sourceForm,
        sourceDocName,
        inventory,
      );
      sharedByHrefAndRole.set(cacheKey, shared);
    }
    if (shared === null) continue;
    assessments.push({ occurrence, ...shared });
  }
  return assessments;
}

/**
 * Extract and assess a document's local targets in one pass — the per-document
 * entry point a derived index or validator drives. Recognition never rewrites
 * authored bytes, and assessment adds no filesystem access of its own beyond the
 * injected inventory.
 */
export function assessLocalTargets(
  markdown: string,
  sourceDocName: string,
  inventory: LocalTargetInventory,
): LocalTargetAssessment[] {
  return assessLocalTargetOccurrences(
    extractLocalTargetOccurrences(markdown),
    sourceDocName,
    inventory,
  );
}

/**
 * Narrow an occurrence's 5-form union to the wire's 3-form subset, or null when
 * the form has no wire spelling.
 *
 * Classification and projection are separate concerns. Every recognized
 * occurrence gets a canonical classification — that is the whole point of the
 * contract, and a form the classifier refuses to answer for is a hole some
 * surface fills by guessing. What reaches a given SURFACE is a narrower,
 * product-level question, and the wire's `LocalTargetSourceForm` has no wiki
 * spelling, so wiki occurrences are classified but not projected here.
 */
function diagnosticSourceForm(form: OccurrenceSourceForm): LocalTargetSourceForm | null {
  switch (form) {
    case 'markdown-inline':
    case 'markdown-reference':
    case 'html-img':
      return form;
    case 'wiki-link':
    case 'wiki-embed':
      return null;
    default: {
      const unreachable: never = form;
      return unreachable;
    }
  }
}

/**
 * Whether an assessment carries onto the local-target wire surfaces (the Links
 * panel's Local files rows and the `localTarget` evidence on a Problems row).
 *
 * Wiki forms are classified but not projected: wiki DOCUMENT links are graph
 * edges the `forwardLinks` union already carries, and file-shaped wiki embeds
 * (`![[assets/diagram.svg]]`) resolve by vault-wide basename under their own
 * contract, which the canonical matrix documents as excluded from Problems and
 * Local files. Projecting either would double-report a target the surfaces
 * already handle correctly.
 */
export function isProjectableToLocalTargetSurfaces(occurrence: LocalTargetOccurrence): boolean {
  return diagnosticSourceForm(occurrence.sourceForm) !== null;
}

/**
 * Project one assessment onto the additive diagnostic evidence carried on both
 * the audit plane and the write advisory, so every consumer describes a target
 * identically (one identity, kind, role, form, reason, and — for a reference
 * use — its shared definition pointer). The caller passes the already-narrowed
 * non-null `reason` (an assessment's `reason` is null exactly when `exact`, and
 * only non-exact occurrences become findings).
 */
export function buildLocalTargetEvidence(
  assessment: LocalTargetAssessment,
  reason: BrokenLinkReason,
): LocalTargetDiagnosticEvidence | null {
  const { occurrence } = assessment;
  const sourceForm = diagnosticSourceForm(occurrence.sourceForm);
  if (sourceForm === null) return null;
  return {
    href: occurrence.href,
    targetKind: assessment.targetKind,
    role: occurrence.role,
    sourceForm,
    resolvedTarget: assessment.resolvedTarget,
    reason,
    resolutionMethod: assessment.resolutionMethod,
    ...(assessment.fallbackTarget === null ? {} : { fallbackTarget: assessment.fallbackTarget }),
    ...(occurrence.reference
      ? {
          definition: {
            line: occurrence.reference.definition.line,
            label: occurrence.reference.definition.label,
          },
        }
      : {}),
  };
}

/**
 * Project a source's assessments onto the Links panel's Local files rows: every
 * local file or image reference, one row per authored occurrence. Documents are
 * excluded because they are graph edges the `forwardLinks` union already carries;
 * an identity-less unresolvable link (no file extension, so no derivable file
 * identity) is excluded too. An image is inherently a file resource, so every
 * image role is included even when its path escapes the content root. Repeated
 * references are never deduplicated — each row keeps its own range so the panel
 * can navigate to every occurrence rather than one collapsed edge.
 */
export function toForwardLinkLocalTargets(
  assessments: readonly LocalTargetAssessment[],
): ForwardLinkLocalTarget[] {
  const rows: ForwardLinkLocalTarget[] = [];
  for (const assessment of assessments) {
    const { occurrence } = assessment;
    if (!isProjectableToLocalTargetSurfaces(occurrence)) continue;
    if (assessment.targetKind !== 'file' && occurrence.role !== 'image') continue;
    const sourceForm = diagnosticSourceForm(occurrence.sourceForm);
    if (sourceForm === null) continue;
    rows.push({
      role: occurrence.role,
      sourceForm,
      targetKind: assessment.targetKind,
      href: occurrence.href,
      resolvedTarget: assessment.resolvedTarget,
      status: assessment.status,
      reason: assessment.reason,
      resolutionMethod: assessment.resolutionMethod,
      fallbackTarget: assessment.fallbackTarget,
      range: { start: occurrence.range.start, end: occurrence.range.end },
      line: occurrence.line,
      column: occurrence.column,
      definition: occurrence.reference
        ? {
            line: occurrence.reference.definition.line,
            label: occurrence.reference.definition.label,
          }
        : null,
    });
  }
  return rows;
}
