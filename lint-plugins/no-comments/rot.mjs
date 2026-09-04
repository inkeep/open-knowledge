export const ROT_SIGNATURES = [
  {
    id: "spec-decision-marker",
    regex: new RegExp("(?<!#)\\bD(?:-[A-Z0-9-]+|\\d+)\\b"),
    fix: "Spec decision markers belong in PR description; remove from source.",
  },
  {
    id: "spec-resolution-status",
    regex: new RegExp("\\b(LOCKED|DIRECTED|DELEGATED|INVESTIGATING|NOT NOW)\\b"),
    fix: "Spec resolution-status tokens belong in decision-log entries; remove from source.",
  },
  {
    id: "non-goal-ad-hoc-tag",
    regex: new RegExp("\\bNG\\d+\\b"),
    fix: "Ad-hoc non-goal tags belong in spec non-goals; for typed taxonomy floors use the sanctioned floor tag.",
  },
  {
    id: "user-story",
    regex: new RegExp("\\bUS-\\d+\\b"),
    fix: "User-story IDs belong in PR description; remove from source.",
  },
  {
    id: "functional-requirement",
    regex: new RegExp("\\bFR-?[A-Z]?\\d+\\b"),
    fix: "Functional-requirement IDs belong in PR description; remove from source.",
  },
  {
    id: "acceptance-criterion",
    regex: new RegExp("\\bAC-?\\d+\\b"),
    fix: "Acceptance-criterion IDs belong in PR description; remove from source.",
  },
  {
    id: "milestone-tag",
    regex: new RegExp("\\bM\\d+\\b(?!-[a-z])"),
    fix: "Milestone tags belong in PR description or commit message; remove from source.",
  },
  {
    id: "feature-version-tag",
    regex: new RegExp("\\bV\\d+-?\\d+\\b"),
    fix: "Feature-work / version tags belong in PR description or commit message; remove from source.",
  },
  {
    id: "audit-finding-id",
    regex: new RegExp("\\bDC-[A-Z]\\d+\\b"),
    fix: "Audit-finding IDs belong in PR description; remove from source.",
  },
  {
    id: "mutation-label",
    regex: new RegExp("\\bMutation [A-Z]\\b"),
    fix: "Mutation labels belong in PR description; remove from source.",
  },
  {
    id: "dated-audit-narrative",
    regex: new RegExp("\\bPer \\d{4}-\\d{2}-\\d{2}\\b"),
    fix: "Dated audit-trail narratives belong in PR description or spec corrigendum; remove from source.",
  },
  {
    id: "post-ship-amendment",
    regex: new RegExp("\\bpost-ship amendment\\b", "i"),
    fix: "Post-ship-amendment language belongs in spec corrigendum; remove from source.",
  },
  {
    id: "planning-narration",
    regex: new RegExp("^[ \\t]*(?:\\/\\/|\\/\\*\\*?|\\*)[ \\t]*(?:originally|initially|previously|we used to)(?=[ \\t]|$)|\\bwe (?:used to|originally|initially|previously)\\b|\\b(?:originally|initially|previously) we\\b|\\bnote that we\\b", "im"),
    fix: "Planning narration belongs in commit message; remove from source.",
  },
  {
    id: "refactor-scaffolding",
    regex: new RegExp(
      "^[ \\t]*(?:\\/\\/+|\\/\\*\\*?|\\*+)?[ \\t]*(?:removed|deleted|deprecated) in\\b|^[ \\t]*(?:\\/\\/|\\/\\*\\*?|\\*)[ \\t]*old:",
      "im",
    ),
    fix: "Refactor scaffolding belongs in commit message; remove from source.",
  },
  {
    id: "non-functional-requirement",
    regex: new RegExp("(?<![A-Za-z])NFR-?\\d+\\b"),
    fix: "Non-functional-requirement IDs belong in PR description; remove from source.",
  },
  {
    id: "spec-path",
    regex: new RegExp("\\bspecs\\/\\d{4}-"),
    fix: "Spec paths belong in PR description or commit message; strip the citation, keep the substance.",
  },
  {
    id: "private-package-reference",
    regex: new RegExp("\\b(?:md-conformance|md-audit|lume-qa)\\b|tests\\/fidelity|fidelity\\/"),
    fix: "Private-package references do not resolve in the public mirror; remove them or rephrase without naming the private tree.",
  },
  {
    id: "tracker-ticket",
    regex: new RegExp("\\bPRD-\\d+\\b"),
    fix: "Tracker tickets belong in the PR / commit; strip the ticket key, keep the behavioral substance.",
  },
  {
    id: "qa-scenario-id",
    regex: new RegExp("\\bQA-\\d{3}\\b"),
    fix: "QA scenario codes cite ephemeral qa-plan artifacts; name the scenario by its behavior instead.",
  },
  {
    id: "review-pass-citation",
    regex: new RegExp("\\bReview Pass \\d|\\bPass \\d+ (?:Critical|Major|Minor)\\b|\\bFinding #\\d+\\b"),
    fix: "Review-pass and finding tags belong in the PR thread; strip the tag, keep the substance.",
  },
  {
    id: "intra-file-line-ref",
    regex: new RegExp("\\bat line \\d{2,}\\b|(?<![A-Za-z0-9])L\\d{3,5}\\b"),
    fix: "Line-number references rot on every edit; point at the named symbol or construct instead.",
  },
];

export const CONTEXT_TERMS = new Map([
  [
    "milestone-tag",
    [
      "\\bMacs?\\b",
      "\\bMacBook\\b",
      "\\barm64\\b",
      "\\bchips?\\b",
      "\\bdevices?\\b",
      "\\bmachines?\\b",
      "\\bnotariz\\w*\\b",
      "\\bhardened runtime\\b",
      "\\bM\\d+\\s+(?:Pro|Max|Ultra|Air|mini)\\b",
    ],
  ],
  [
    "acceptance-criterion",
    ["\\bAC3\\b", "\\bbitstream\\b", "\\bpassthrough\\b", "\\bffmpeg\\b", "\\d+\\s?k?Hz\\b"],
  ],
  ["spec-decision-marker", ["\\bD-?BUS\\b"]],
]);

export const CONTEXT_VOCABULARY = new Map(
  [...CONTEXT_TERMS].map(([id, terms]) => [id, new RegExp(terms.join("|"), "i")]),
);

export function findRotMatches(text) {
  const raw = [];
  for (const signature of ROT_SIGNATURES) {
    if (CONTEXT_VOCABULARY.get(signature.id)?.test(text)) continue;
    const match = signature.regex.exec(text);
    if (match) {
      raw.push({
        id: signature.id,
        token: match[0],
        fix: signature.fix,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  return raw
    .filter(
      (hit) =>
        !raw.some(
          (other) =>
            other !== hit &&
            other.start <= hit.start &&
            hit.end <= other.end &&
            other.end - other.start > hit.end - hit.start,
        ),
    )
    .map(({ id, token, fix }) => ({ id, token, fix }));
}
