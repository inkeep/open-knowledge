import { describe, expect, test } from "bun:test";
import { deriveStableTag, parseBetaTags, selectPromotion } from "./promote-stable-auto.mjs";

// Fixed clock so tests never call Date.now().
const NOW = Date.parse("2026-07-08T20:00:00Z");
const SOAK = 86400; // 24h
const SOAKED = "2026-07-07T14:00:00Z"; // 30h before NOW
const FRESH = "2026-07-08T17:00:00Z"; // 3h before NOW

function meta({ isDraft = false, publishedAt = SOAKED, dmg = true, manifest = true } = {}) {
  const assets = [];
  if (dmg) assets.push({ name: "OpenKnowledge-universal.dmg" });
  if (manifest) assets.push({ name: "beta-mac.yml" });
  return { isDraft, publishedAt, assets };
}

// Build a fetchReleaseMeta from a tag->meta map. Unknown tag === 404 (null);
// the sentinel "THROW" simulates a non-404 infra error.
function fetcher(map) {
  return (tag) => {
    if (!(tag in map)) return null;
    if (map[tag] === "THROW") throw new Error("simulated non-404 infra error");
    return map[tag];
  };
}

const noneExist = () => false;
const existsIn = (...tags) => {
  const set = new Set(tags);
  return (t) => set.has(t);
};

const select = (over) =>
  selectPromotion({ tagExists: noneExist, soakSeconds: SOAK, nowMs: NOW, ...over });

describe("deriveStableTag", () => {
  test("strips the -beta.N suffix", () => {
    expect(deriveStableTag("v0.9.0-beta.1")).toBe("v0.9.0");
    expect(deriveStableTag("v1.2.3-beta.0")).toBe("v1.2.3");
  });
  test("keeps double-digit beta numbers intact", () => {
    expect(deriveStableTag("v0.10.0-beta.10")).toBe("v0.10.0");
  });
  test("throws on a non-beta tag", () => {
    expect(() => deriveStableTag("v0.10.0")).toThrow();
    expect(() => deriveStableTag("random")).toThrow();
  });
});

describe("parseBetaTags", () => {
  test("filters to conforming beta tags, preserving order", () => {
    const raw = "v0.10.0-beta.6\nv0.10.0\nrandomtag\n\nv0.10.0-beta.5\nv0.9.0-beta.12\n";
    expect(parseBetaTags(raw)).toEqual(["v0.10.0-beta.6", "v0.10.0-beta.5", "v0.9.0-beta.12"]);
  });
  test("empty input yields no tags", () => {
    expect(parseBetaTags("")).toEqual([]);
  });
});

describe("selectPromotion", () => {
  test("reaches back to the latest soaked beta when the head is under-soaked", () => {
    const r = select({
      betaTags: ["v0.10.0-beta.6", "v0.10.0-beta.5"],
      fetchReleaseMeta: fetcher({
        "v0.10.0-beta.6": meta({ publishedAt: FRESH }),
        "v0.10.0-beta.5": meta({ publishedAt: SOAKED }),
      }),
    });
    expect(r).toEqual({ kind: "select", target: "v0.10.0-beta.5", stableTag: "v0.10.0" });
  });

  test("selects the head when the head itself is soaked", () => {
    const r = select({
      betaTags: ["v0.10.0-beta.6", "v0.10.0-beta.5"],
      fetchReleaseMeta: fetcher({
        "v0.10.0-beta.6": meta({ publishedAt: SOAKED }),
        "v0.10.0-beta.5": meta({ publishedAt: SOAKED }),
      }),
    });
    expect(r).toEqual({ kind: "select", target: "v0.10.0-beta.6", stableTag: "v0.10.0" });
  });

  test("stops at the first already-promoted beta and never reaches an older cycle", () => {
    const r = select({
      betaTags: ["v0.10.0-beta.6", "v0.9.0-beta.3"],
      tagExists: existsIn("v0.10.0"), // beta.6's stable already exists
      fetchReleaseMeta: fetcher({
        "v0.9.0-beta.3": meta({ publishedAt: SOAKED }), // soaked but must NOT be chosen
      }),
    });
    expect(r.kind).toBe("stop-promoted");
    expect(r.beta).toBe("v0.10.0-beta.6");
    expect(r.stableTag).toBe("v0.10.0");
    expect(r.target).toBeUndefined();
  });

  test("skips a draft head and promotes the older soaked beta", () => {
    const r = select({
      betaTags: ["v0.10.0-beta.6", "v0.10.0-beta.5"],
      fetchReleaseMeta: fetcher({
        "v0.10.0-beta.6": meta({ isDraft: true, publishedAt: SOAKED }),
        "v0.10.0-beta.5": meta({ publishedAt: SOAKED }),
      }),
    });
    expect(r).toEqual({ kind: "select", target: "v0.10.0-beta.5", stableTag: "v0.10.0" });
  });

  test("skips a head missing the DMG asset", () => {
    const r = select({
      betaTags: ["v0.10.0-beta.6", "v0.10.0-beta.5"],
      fetchReleaseMeta: fetcher({
        "v0.10.0-beta.6": meta({ dmg: false }),
        "v0.10.0-beta.5": meta(),
      }),
    });
    expect(r.target).toBe("v0.10.0-beta.5");
  });

  test("skips a head missing the mac.yml manifest", () => {
    const r = select({
      betaTags: ["v0.10.0-beta.6", "v0.10.0-beta.5"],
      fetchReleaseMeta: fetcher({
        "v0.10.0-beta.6": meta({ manifest: false }),
        "v0.10.0-beta.5": meta(),
      }),
    });
    expect(r.target).toBe("v0.10.0-beta.5");
  });

  test("treats a 404 (null) as no-release-yet and considers the next-older beta", () => {
    const r = select({
      betaTags: ["v0.10.0-beta.6", "v0.10.0-beta.5"],
      fetchReleaseMeta: fetcher({
        // beta.6 unknown -> 404 -> null
        "v0.10.0-beta.5": meta(),
      }),
    });
    expect(r.target).toBe("v0.10.0-beta.5");
  });

  test("returns none when nothing is soaked", () => {
    const r = select({
      betaTags: ["v0.10.0-beta.2", "v0.10.0-beta.1"],
      fetchReleaseMeta: fetcher({
        "v0.10.0-beta.2": meta({ publishedAt: FRESH }),
        "v0.10.0-beta.1": meta({ publishedAt: FRESH }),
      }),
    });
    expect(r).toEqual({ kind: "none" });
  });

  test("propagates a non-404 infra error instead of skipping the candidate (fail loud)", () => {
    expect(() =>
      select({
        betaTags: ["v0.10.0-beta.6", "v0.10.0-beta.5"],
        fetchReleaseMeta: fetcher({
          "v0.10.0-beta.6": "THROW", // auth/network/rate-limit on the newest candidate
          "v0.10.0-beta.5": meta(), // would otherwise be wrongly promoted as latest
        }),
      }),
    ).toThrow(/infra error/);
  });
});
