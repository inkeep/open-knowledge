import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyPatchWithConflictDetection,
  buildCommitAttribution,
  buildPublicComment,
  checkOrgMembership,
  commitIndicatesConflicts,
  createClaGateGh,
  listPublicPrCommitAuthors,
  normalizeGitHubUserAuthor,
  postCommitStatus,
  readCommitClaStatus,
  syncPublicPr,
} from "./bridge-public-pr-to-monorepo.mjs";

// A fake `githubRequest`: records every call and returns the queued response.
// The bridge's GitHub adapters are the only seam where the `license/cla` and
// `cla/verified` context strings (the gate's enforcement surface) live, so the
// tests assert the request shape at that boundary, not internal call counts.
const fakeRequest = (response) => {
  const calls = [];
  const request = async (args) => {
    calls.push(args);
    return response;
  };
  return { request, calls };
};

describe("buildCommitAttribution", () => {
  test("credits every unique human author with native coauthor trailers", () => {
    const attribution = buildCommitAttribution({
      commitAuthors: [
        { name: "Sarah Inkeep", email: "sarah@inkeep.com" },
        { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" },
        { name: "Sarah Inkeep", email: "sarah@inkeep.com" },
        { name: "Robert Inkeep", email: "robert@inkeep.com" },
      ],
      fallbackAuthor: { name: "octocat", email: "1+octocat@users.noreply.github.com" },
    });

    expect(attribution.trailers).toEqual([
      "Co-authored-by: Sarah Inkeep <sarah@inkeep.com>",
      "Co-authored-by: Robert Inkeep <robert@inkeep.com>",
    ]);
  });

  test("falls back to the public PR author when commits only have invalid authors", () => {
    const attribution = buildCommitAttribution({
      commitAuthors: [
        { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" },
        { name: "Bad\nName", email: "bad@example.com" },
      ],
      fallbackAuthor: { name: "octocat", email: "1+octocat@users.noreply.github.com" },
    });

    expect(attribution.trailers).toEqual([
      "Co-authored-by: octocat <1+octocat@users.noreply.github.com>",
    ]);
  });
});

describe("normalizeGitHubUserAuthor", () => {
  test("uses the GitHub-resolved user id/login noreply identity", () => {
    expect(normalizeGitHubUserAuthor({ login: "rtran9", id: 11001605 })).toEqual({
      name: "rtran9",
      email: "11001605+rtran9@users.noreply.github.com",
    });
  });

  test("ignores unresolved and bot users so callers can fall back", () => {
    expect(normalizeGitHubUserAuthor(null)).toBeNull();
    expect(normalizeGitHubUserAuthor({ login: "github-actions[bot]", id: 41898282 })).toBeNull();
  });
});

describe("listPublicPrCommitAuthors", () => {
  test("paginates through every public PR commit author", async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) => ({
      author: { login: `author-${index}`, id: index + 1 },
      commit: { author: { name: `Commit ${index}`, email: `commit-${index}@example.com` } },
    }));
    const pageTwo = [
      {
        author: { login: "final-author", id: 101 },
        commit: { author: { name: "Final Commit", email: "final@example.com" } },
      },
    ];
    const calls = [];
    const request = async (args) => {
      calls.push(args);
      return calls.length === 1 ? pageOne : pageTwo;
    };

    const authors = await listPublicPrCommitAuthors({
      token: "t",
      repo: "owner/repo",
      prNumber: 123,
      request,
    });

    expect(authors).toHaveLength(101);
    expect(authors.at(-1)).toEqual({
      name: "final-author",
      email: "101+final-author@users.noreply.github.com",
    });
    expect(calls.map((call) => call.path)).toEqual([
      "/repos/owner/repo/pulls/123/commits?per_page=100&page=1",
      "/repos/owner/repo/pulls/123/commits?per_page=100&page=2",
    ]);
  });

  test("falls back to raw commit author when GitHub has no linked user", async () => {
    const { request } = fakeRequest([
      {
        author: null,
        commit: { author: { name: "Patch Author", email: "patch-author@example.com" } },
      },
    ]);

    await expect(
      listPublicPrCommitAuthors({
        token: "t",
        repo: "owner/repo",
        prNumber: 123,
        request,
      }),
    ).resolves.toEqual([{ name: "Patch Author", email: "patch-author@example.com" }]);
  });
});

describe("readCommitClaStatus", () => {
  test("extracts the license/cla state from the combined status", async () => {
    const { request } = fakeRequest({
      statuses: [
        { context: "ci/build", state: "success" },
        { context: "license/cla", state: "success" },
      ],
    });
    expect(await readCommitClaStatus({ token: "t", repo: "o/r", sha: "abc", request })).toBe(
      "success",
    );
  });

  test("returns null when the license/cla context is absent", async () => {
    const { request } = fakeRequest({ statuses: [{ context: "ci/build", state: "failure" }] });
    expect(await readCommitClaStatus({ token: "t", repo: "o/r", sha: "abc", request })).toBeNull();
  });

  test("returns null for an empty status set", async () => {
    const { request } = fakeRequest({ statuses: [] });
    expect(await readCommitClaStatus({ token: "t", repo: "o/r", sha: "abc", request })).toBeNull();
  });

  test("requests the combined status with per_page=100 so license/cla can't fall off page 1", async () => {
    const { request, calls } = fakeRequest({ statuses: [] });
    await readCommitClaStatus({ token: "t", repo: "owner/repo", sha: "deadbeef", request });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/repos/owner/repo/commits/deadbeef/status?per_page=100");
  });
});

describe("postCommitStatus", () => {
  test("POSTs the given state/context/description to the commit's statuses endpoint", async () => {
    const { request, calls } = fakeRequest(undefined);
    await postCommitStatus({
      token: "t",
      repo: "owner/repo",
      sha: "abc123",
      state: "failure",
      context: "cla/verified",
      description: "held",
      request,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/repos/owner/repo/statuses/abc123",
      body: { state: "failure", context: "cla/verified", description: "held" },
    });
  });
});

describe("checkOrgMembership", () => {
  test("returns true on a 204 (member)", async () => {
    const { request, calls } = fakeRequest(null);
    expect(
      await checkOrgMembership({ token: "t", org: "inkeep", login: "octocat", request }),
    ).toBe(true);
    expect(calls[0].path).toBe("/orgs/inkeep/members/octocat");
  });

  test("returns false on a 404 (non-member)", async () => {
    const request = async () => {
      const error = new Error("not found (404)");
      error.status = 404;
      throw error;
    };
    expect(
      await checkOrgMembership({ token: "t", org: "inkeep", login: "outsider", request }),
    ).toBe(false);
  });

  test("propagates non-404 errors so the gate fails closed", async () => {
    const request = async () => {
      const error = new Error("forbidden (403)");
      error.status = 403;
      throw error;
    };
    await expect(
      checkOrgMembership({ token: "t", org: "inkeep", login: "x", request }),
    ).rejects.toThrow(/403/);
  });
});

describe("createClaGateGh", () => {
  const deps = {
    publicToken: "public-token",
    publicRepo: "inkeep/open-knowledge",
    internalToken: "internal-token",
    internalRepo: "inkeep/agents-private",
  };

  test("readClaStatus reads license/cla from the public PR head, on the public token", async () => {
    const { request, calls } = fakeRequest({
      statuses: [{ context: "license/cla", state: "pending" }],
    });
    const gh = createClaGateGh({ ...deps, request });
    const state = await gh.readClaStatus({ head: { sha: "public-head" } });
    expect(state).toBe("pending");
    expect(calls[0].token).toBe("public-token");
    expect(calls[0].path).toBe(
      "/repos/inkeep/open-knowledge/commits/public-head/status?per_page=100",
    );
  });

  test("setVerifiedStatus posts the cla/verified context to the internal PR head", async () => {
    const { request, calls } = fakeRequest(undefined);
    const gh = createClaGateGh({ ...deps, request });
    await gh.setVerifiedStatus({ head: { sha: "internal-head" } }, "failure", "needs signature");
    expect(calls).toHaveLength(1);
    expect(calls[0].token).toBe("internal-token");
    expect(calls[0].path).toBe("/repos/inkeep/agents-private/statuses/internal-head");
    expect(calls[0].body).toEqual({
      state: "failure",
      context: "cla/verified",
      description: "needs signature",
    });
  });

  test("isOrgMember checks the internal repo's org on the internal token", async () => {
    const { request, calls } = fakeRequest(null);
    const gh = createClaGateGh({ ...deps, request });
    expect(await gh.isOrgMember("octocat")).toBe(true);
    expect(calls[0].token).toBe("internal-token");
    expect(calls[0].path).toBe("/orgs/inkeep/members/octocat");
  });
});

// --- Graceful conflict routing canary (real `git apply --index --3way`) ------
//
// Guards the conflict-classification invariant: a contributor patch built
// against the comment-STRIPPED public mirror must NOT hard-fail the bridge when
// it 3-way-conflicts with the comment-RICH internal tree — it must be classified
// as a resolvable 'conflicts' outcome (routed to a draft maintainer PR), while a
// genuine non-apply stays 'failed' (fail-closed). Exercises the bridge's REAL
// command, not a mock.

const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

// Build a real temp git repo: BASE = the comment-stripped public version (so the
// patch's base blob is reachable for the 3-way), a patch = the contributor's
// change against BASE, and the working tree = OURS (the comment-rich internal
// version) the bridge applies onto. Returns { repoDir, patchFile, cleanup }.
function setupBridgeRepo({ baseContent, oursContent, theirsContent }) {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-canary-"));
  const repoDir = path.join(root, "repo");
  mkdirSync(repoDir);
  git(repoDir, "init", "-q");
  git(repoDir, "config", "user.email", "canary@test.local");
  git(repoDir, "config", "user.name", "canary");
  writeFileSync(path.join(repoDir, "f.ts"), baseContent);
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-qm", "base");
  const base = git(repoDir, "rev-parse", "HEAD");
  const defaultBranch = git(repoDir, "rev-parse", "--abbrev-ref", "HEAD");
  // theirs = the contributor's change against the stripped base, captured as a diff
  git(repoDir, "checkout", "-q", "-b", "contributor");
  writeFileSync(path.join(repoDir, "f.ts"), theirsContent);
  git(repoDir, "commit", "-qam", "contributor change");
  const patch = git(repoDir, "diff", base, "HEAD");
  const patchFile = path.join(root, "contributor.patch");
  writeFileSync(patchFile, `${patch}\n`);
  // ours = the comment-rich internal version, checked out as the apply target
  git(repoDir, "checkout", "-q", defaultBranch);
  writeFileSync(path.join(repoDir, "f.ts"), oursContent);
  git(repoDir, "commit", "-qam", "internal (comment-rich)");
  return {
    repoDir,
    patchFile,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const STRIPPED_BASE = "export const A = 1;\nexport const B = 2;\nexport const C = 3;\n";

describe("applyPatchWithConflictDetection (graceful conflict routing canary)", () => {
  test("a comment-adjacency 3-way conflict is classified 'conflicts', not a hard failure", () => {
    // OURS adds a comment on the SAME line the contributor edits — the exact
    // comment-strip divergence that broke the bridge. Guaranteed 3-way conflict.
    const { repoDir, patchFile, cleanup } = setupBridgeRepo({
      baseContent: STRIPPED_BASE,
      theirsContent: "export const A = 1;\nexport const B = 22;\nexport const C = 3;\n",
      oursContent:
        "export const A = 1;\nexport const B = 2; // important constant (mirror strips this)\nexport const C = 3;\n",
    });
    try {
      const result = applyPatchWithConflictDetection(repoDir, patchFile);
      expect(result.outcome).toBe("conflicts");
      expect(result.conflictedPaths).toContain("f.ts");
    } finally {
      cleanup();
    }
  });

  test("a divergence far from the contributor's edit applies 'clean'", () => {
    // The contributor edits B (top); OURS's comment divergence is at C (bottom),
    // separated by filler so they land in DIFFERENT diff hunks → 3-way merges
    // cleanly. (Adjacent divergences share a hunk and conflict; that's exactly
    // why the bridge conflicts on comment-dense regions.)
    const longBase =
      "export const A = 1;\nexport const B = 2;\n" +
      "const p = 0;\nconst q = 0;\nconst r = 0;\nconst s = 0;\nconst u = 0;\nconst v = 0;\n" +
      "export const C = 3;\n";
    const { repoDir, patchFile, cleanup } = setupBridgeRepo({
      baseContent: longBase,
      theirsContent: longBase.replace("export const B = 2;", "export const B = 22;"),
      oursContent: longBase.replace(
        "export const C = 3;",
        "export const C = 3; // note on C (mirror strips this)",
      ),
    });
    try {
      const result = applyPatchWithConflictDetection(repoDir, patchFile);
      expect(result.outcome).toBe("clean");
      expect(result.conflictedPaths).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("a genuinely un-appliable patch stays 'failed' (fail-closed, not swallowed)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-canary-failed-"));
    const repoDir = path.join(root, "repo");
    mkdirSync(repoDir);
    git(repoDir, "init", "-q");
    git(repoDir, "config", "user.email", "canary@test.local");
    git(repoDir, "config", "user.name", "canary");
    writeFileSync(path.join(repoDir, "f.ts"), STRIPPED_BASE);
    git(repoDir, "add", "-A");
    git(repoDir, "commit", "-qm", "base");
    // A patch against a file that does not exist, whose base blobs are absent —
    // git apply --3way can neither apply it directly nor reconstruct a 3-way base.
    const ghostPatch = [
      "diff --git a/ghost.ts b/ghost.ts",
      "index 1111111..2222222 100644",
      "--- a/ghost.ts",
      "+++ b/ghost.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const patchFile = path.join(root, "ghost.patch");
    writeFileSync(patchFile, ghostPatch);
    try {
      const result = applyPatchWithConflictDetection(repoDir, patchFile);
      expect(result.outcome).toBe("failed");
      expect(result.conflictedPaths).toHaveLength(0);
      expect(result.message).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("conflict and failure comments give accurate guidance and never advise a rebase", () => {
    const publicPr = {
      user: { login: "octocat" },
      base: { repo: { full_name: "inkeep/open-knowledge" } },
    };
    const conflicts = buildPublicComment({ publicPr, status: "conflicts" });
    const failed = buildPublicComment({
      publicPr,
      status: "failed",
      details: "The diff could not be applied to the internal monorepo.",
    });
    for (const body of [conflicts, failed]) {
      expect(body.toLowerCase()).not.toContain("rebase");
    }
    expect(conflicts).toContain("No action is needed from you");
    expect(conflicts).toContain("@octocat");
    // upsertIssueComment finds+updates the existing comment by this marker; if the
    // conflicts branch dropped it, every metadata re-sync would post a duplicate.
    expect(conflicts).toContain("<!-- monorepo-pr-bridge -->");
  });
});

describe("commitIndicatesConflicts (metadata-re-sync conflict-hold guard)", () => {
  test("true for a conflict-marker mirror commit message", () => {
    expect(
      commitIndicatesConflicts(
        "chore(sync): mirror inkeep/open-knowledge#310 (with conflicts; needs manual resolution)",
      ),
    ).toBe(true);
  });

  test("false for a clean mirror commit message", () => {
    expect(commitIndicatesConflicts("chore(sync): mirror inkeep/open-knowledge#310")).toBe(false);
  });

  test("false for absent / non-string input", () => {
    expect(commitIndicatesConflicts(undefined)).toBe(false);
    expect(commitIndicatesConflicts(null)).toBe(false);
    expect(commitIndicatesConflicts(42)).toBe(false);
  });
});

// --- Metadata-event composition test (guards the conflict-hold fail-open) -----
//
// On a metadata-only re-sync (e.g. a contributor editing their PR body)
// syncPublicPr skips the apply block, so hasConflicts must be re-derived from
// the internal PR's head-commit marker; otherwise a conflict-carrying DRAFT PR
// is silently un-drafted (markPullRequestReadyForReview) and its comment flips
// to 'synced'. Per-predicate unit tests (canary, predicate, forceDraft) cannot
// reach this wiring. This runs the REAL syncPublicPr metadata path (zero git
// ops) with the GitHub API faked at the true external boundary, asserting the
// observable draft/comment OUTCOME, not call counts.

const CONFLICT_HEAD =
  "chore(sync): mirror inkeep/open-knowledge#310 (with conflicts; needs manual resolution)";
const CLEAN_HEAD = "chore(sync): mirror inkeep/open-knowledge#310";

// Drive the real syncPublicPr through a metadata-only ('edited') event with the
// GitHub API faked. Returns the load-bearing observable mutations it made.
async function runMetadataSync({ headCommitMessage, internalPrStartsDraft }) {
  const recorded = { draftMutation: null, comment: null };
  const internalPr = {
    number: 42,
    node_id: "PR_node_42",
    draft: internalPrStartsDraft,
    head: { sha: "internal-head-sha" },
    html_url: "https://github.com/inkeep/agents-private/pull/42",
  };
  const publicPr = {
    number: 310,
    title: "Fix something",
    body: "body",
    html_url: "https://github.com/inkeep/open-knowledge/pull/310",
    user: { login: "octocat", id: 99 },
    base: { ref: "main", repo: { full_name: "inkeep/open-knowledge" } },
    head: { label: "octocat:branch", sha: "public-head-sha" },
    draft: false,
  };
  const json = (obj, status = 200) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(obj),
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    if (method === "GET" && url.includes("/repos/inkeep/open-knowledge/pulls/310")) return json(publicPr);
    if (method === "GET" && url.includes("/pulls?state=open")) return json([internalPr]);
    if (method === "GET" && url.includes("/commits/internal-head-sha") && !url.includes("/status")) {
      return json({ commit: { message: headCommitMessage } });
    }
    if (method === "PATCH" && url.includes("/pulls/42")) return json(internalPr);
    if (method === "GET" && url.includes("/orgs/")) return json({ message: "Not Found" }, 404); // non-member
    if (method === "GET" && url.includes("/commits/public-head-sha/status")) {
      return json({ statuses: [{ context: "license/cla", state: "success" }] }); // CLA signed -> not gated
    }
    if (method === "POST" && url.endsWith("/graphql")) {
      const q = JSON.parse(init.body).query;
      recorded.draftMutation = q.includes("convertPullRequestToDraft")
        ? "to-draft"
        : q.includes("markPullRequestReadyForReview")
          ? "to-ready"
          : "unknown";
      return json({ data: {} });
    }
    if (method === "POST" && url.includes("/statuses/")) return json({});
    if (method === "GET" && url.includes("/issues/310/comments")) return json([]);
    if (method === "POST" && url.includes("/issues/310/comments")) {
      recorded.comment = JSON.parse(init.body).body;
      return json({ html_url: "https://github.com/x/comments/1" });
    }
    throw new Error(`unrouted request: ${method} ${url}`);
  };

  const setKeys = {
    PUBLIC_TOKEN: "pub",
    INTERNAL_TOKEN: "int",
    PUBLIC_REPO: "inkeep/open-knowledge",
    INTERNAL_REPO: "inkeep/agents-private",
    INTERNAL_REPO_DIR: "/tmp/unused-on-metadata-path",
    MONOREPO_PATH_PREFIX: "public/open-knowledge",
    INTERNAL_BASE_REF: "main",
    INTERNAL_BRANCH_PREFIX: "public-pr/open-knowledge",
    PUBLIC_PR_NUMBER: "310",
    PUBLIC_PR_ACTION: "edited",
  };
  const saved = {};
  for (const k of Object.keys(setKeys)) saved[k] = process.env[k];
  Object.assign(process.env, setKeys);
  try {
    await syncPublicPr();
  } finally {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(setKeys)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  return recorded;
}

describe("syncPublicPr metadata-event composition (conflict-hold fail-open guard)", () => {
  test("a metadata event on a DRAFT conflict PR keeps it draft and posts 'conflicts' (not un-draft + 'synced')", async () => {
    const r = await runMetadataSync({ headCommitMessage: CONFLICT_HEAD, internalPrStartsDraft: true });
    // Without the conflict-hold re-derivation, this fires
    // markPullRequestReadyForReview. Correct: the conflict hold is re-derived
    // true -> shouldBeDraft true -> already draft -> NO transition fires.
    expect(r.draftMutation).toBeNull();
    expect(r.comment).toContain("No action is needed from you");
    expect(r.comment.toLowerCase()).not.toContain("rebase");
    expect(r.comment).not.toContain("review and merge your PR"); // not the 'synced' body
  });

  test("a metadata event on a clean PR readies it and posts 'synced'", async () => {
    const r = await runMetadataSync({ headCommitMessage: CLEAN_HEAD, internalPrStartsDraft: true });
    expect(r.draftMutation).toBe("to-ready");
    expect(r.comment).toContain("review and merge your PR"); // the 'synced' body
  });

  test("a metadata event on a non-draft PR whose head now carries conflicts re-drafts it", async () => {
    const r = await runMetadataSync({ headCommitMessage: CONFLICT_HEAD, internalPrStartsDraft: false });
    // Symmetric to the draft case: the conflict hold is re-derived true ->
    // shouldBeDraft true -> PR is currently ready -> convertPullRequestToDraft fires.
    expect(r.draftMutation).toBe("to-draft");
    expect(r.comment).toContain("No action is needed from you");
  });
});
