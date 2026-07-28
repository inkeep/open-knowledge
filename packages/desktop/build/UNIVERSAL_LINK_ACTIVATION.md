# Universal Link Activation — OPS Runbook

**Last updated:** 2026-05-18

## What this document covers

The macOS share-receive flow routes inbound `https://openknowledge.ai/d/<encoded>` clicks (Slack, iMessage, email previews) directly into the installed OpenKnowledge app via Apple's Handoff / Universal Links mechanism. Four load-bearing artifacts in this directory must stay aligned for that to work:

1. **`build/entitlements.mac.plist`** — declares the `com.apple.developer.associated-domains` entitlement with `applinks:openknowledge.ai` + `applinks:www.openknowledge.ai`. This is what the kernel checks when AppKit is asked to deliver an inbound Universal Link to the app. **Applied to the MAIN binary only** (`mac.entitlements` in `electron-builder.yml`).
2. **`build/entitlements.mac.inherit.plist`** — helper-only plist for helper processes (Renderer / GPU / Plugin / utility-process.fork children). Excludes `com.apple.developer.associated-domains` because that entitlement is restricted (requires an embedded provisioning profile to claim, and helpers do not carry one — macOS 26.4.x AMFI SIGKILLs helpers that claim restricted entitlements without a profile, producing the `exit_code=9` failure mode that blocks project open). Wired via `mac.entitlementsInherit` in `electron-builder.yml`. The contract test at `tests/unit/entitlements-helper-split.test.ts` prevents drift.
3. **`build/embedded.provisionprofile`** — Developer-ID provisioning profile, CMS-signed by Apple, granting the app the right to use the restricted `com.apple.developer.associated-domains` entitlement at codesign time. Without it, `codesign` rejects the binary at notarize time with "not authorized to use restricted entitlement."
4. **`electron-builder.yml`** — `mac.provisioningProfile: build/embedded.provisionprofile` setting that tells electron-builder to embed the profile inside the packaged `.app`. Plus `mac.extendInfo.NSUserActivityTypes: [NSUserActivityTypeBrowsingWeb]` which is required for AppKit to dispatch `continue-activity` events to the app — without it, even a perfectly-entitled binary silently drops Handoff payloads (`LSOpenURLsWithRole error -10810` in console.app). Plus the `mac.entitlements` vs `mac.entitlementsInherit` split called out above — pointing both at the same plist is the documented anti-pattern that broke helper spawn on macOS 26.4.x.

Cross-references:
- [`SPEC.md`](../../../specs/2026-05-14-sharing-virality-flow/SPEC.md) §9 (Proposed solution / Architecture overview), §13 (Deployment / rollout considerations)
- D7 (splash as the recovery surface during AASA cache warm-up)
- D16 (Apple Team ID `6NZGSG335T`, public per Zed precedent)
- D17 (provisioning profile pipeline — additive to electron-builder.yml; revised mid-/ship to land all artifacts together)
- D23 (Apple Account Holder identified + reachable, one-time portal work complete)

## Verification checklist

Run these commands locally on macOS before shipping the next DMG that carries Universal Link support.

### 1. Build dry-run (no codesigning required)

```sh
cd public/open-knowledge && pnpm build:desktop
```

Should succeed without `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` / `APPLE_TEAM_ID` env vars set. The afterSign pipeline at `scripts/afterSign.mjs` no-ops when codesigning credentials are absent (`build:mac:unsigned` path), so the entitlement + profile additions don't break the unsigned build.

### 2. Profile metadata sanity check

```sh
security cms -D -i packages/desktop/build/embedded.provisionprofile | plutil -p -
```

Confirm the output contains (verbatim):

```
"AppIDName" => "OpenKnowledge"
"TeamIdentifier" => [ "6NZGSG335T" ]
"application-identifier" => "6NZGSG335T.com.inkeep.open-knowledge"
"com.apple.developer.associated-domains" => "*"
"ExpirationDate" => 2044-05-10 01:05:26 +0000
"ProvisionsAllDevices" => 1
```

The `"*"` wildcard for `com.apple.developer.associated-domains` is the most permissive form — it accepts any `applinks:<host>` declaration in the binary's entitlements plist, so future host additions (e.g. a `applinks:beta.openknowledge.ai`) won't require a profile re-issue. If you ever see a narrower form (e.g. an explicit array of hosts), the profile was generated against a specific applinks set + must be re-issued from the Apple Developer Portal before adding new hosts to `entitlements.mac.plist`.

### 3. Signed build verification (when codesigning identity is available)

```sh
cd public/open-knowledge && pnpm build:desktop  # with CSC_LINK + CSC_KEY_PASSWORD set
codesign -d --entitlements - 'packages/desktop/dist-desktop/mac-arm64/OpenKnowledge.app' 2>&1 | head -40
```

Should include:

```xml
<key>com.apple.developer.associated-domains</key>
<array>
    <string>applinks:openknowledge.ai</string>
    <string>applinks:www.openknowledge.ai</string>
</array>
```

If the entitlement is absent from the codesign output, the build pipeline silently dropped `entitlements.mac.plist` — investigate `entitlementsInherit` + `extendInfo` precedence in `electron-builder.yml`.

If signing isn't available locally (the common dev case), skip this check and rely on the next signed CI run to verify. The first signed beta DMG that carries this entitlement should pass codesign + notarize cleanly because the profile's wildcard `*` accepts the embedded `applinks:` array.

### 4. Post-deploy AASA fetch (after openknowledge.ai serves the AASA file)

```sh
sudo swcutil dl -d openknowledge.ai
```

Apple's `swcd` daemon caches the AASA file for up to 8 days (including negative caches per Apple's published behavior). Force a refresh with this command. Output should show a successful 200 OK fetch + JSON body matching the expected schema (`appID: 6NZGSG335T.com.inkeep.open-knowledge`, `paths: [/d/*]`).

If `swcutil dl` shows a 404 or stale entry past the deploy window, the AASA file isn't reaching macOS clients. Re-verify:
- `https://openknowledge.ai/.well-known/apple-app-site-association` returns 200 with `Content-Type: application/json` (NOT `application/json; charset=utf-8`).
- Same for `https://www.openknowledge.ai/.well-known/...` — both hosts MUST serve from the first shipped version per the dual-host discipline note in SPEC §13 (Q-B3 / audit Challenger F8 — reversing the host list requires waiting out Apple's 8-day negative cache).
- AASA file size is < 128 KB (Apple's hard cap).

### 5. End-to-end Universal Link click test

1. Send yourself a share URL via iMessage or paste into Apple Notes: `https://openknowledge.ai/d/<encoded>`.
2. Click the URL.
3. OpenKnowledge should launch (or focus its existing window) and route to the shared doc via the Q1/Q2/Q3 receive dialog (US-014). The first click after install may bounce to the splash page once — Apple's known AASA gate for Developer-ID apps (WWDC20 forum thread 649189). The splash page's "Open in OpenKnowledge" button (custom-scheme fallback per D7) handles that case.

If the click goes to the browser indefinitely (not just the first time):
- `swcutil dl -d openknowledge.ai` may show a stale negative cache.
- Verify the entitlement is present in the running `.app` via `codesign -d --entitlements -` (see step 3).
- Verify `NSUserActivityTypes` is in `OpenKnowledge.app/Contents/Info.plist` via `plutil -p 'packages/desktop/dist-desktop/mac-arm64/OpenKnowledge.app/Contents/Info.plist' | grep -A2 NSUserActivityTypes`.

## AASA cache warm-up timing

The AASA file deploy on `openknowledge.ai` should be live + cached for **24-72 hours** before the first DMG that carries this entitlement reaches users. Apple's `swcd` fetches AASA on first launch of a notarized Developer-ID app — if the file isn't yet published, the cached "no AASA" entry sticks for up to 8 days (Apple's negative-cache window). The splash page's custom-scheme button (per D7) is the recovery surface during the warm-up window.

If you're shipping the entitled DMG before the AASA file is reachable, that's fine — the splash page handles it. But if you want the "Universal Link → OK direct" experience for early users, ship the AASA file first + wait the warm-up window before the desktop release.

## Profile expiry

The committed profile (`build/embedded.provisionprofile`) carries `ExpirationDate: 2044-05-10`. Developer-ID profiles re-issued through the Apple Developer Portal typically inherit a 1-year-from-issue expiry. Re-generate + commit a fresh profile when:

- The current profile's `ExpirationDate` is within 30 days.
- The certificate the profile was issued against is rotated (e.g. annual Developer-ID certificate renewal).
- A new applinks host is added AND the profile's `com.apple.developer.associated-domains` was a narrowed list (not the wildcard `*` we have today).

To re-generate:

1. Sign in to https://developer.apple.com/account/resources/profiles/list as the Apple Account Holder.
2. Find the existing "OpenKnowledge Developer-ID" profile.
3. Click "Edit" → re-generate against the same App ID + Developer-ID certificate.
4. Download the `.provisionprofile` binary + commit to `packages/desktop/build/embedded.provisionprofile`.
5. Re-run the verification checklist above.

## Troubleshooting

### `codesign` fails with "not authorized to use restricted entitlement"

The profile binary is missing or doesn't grant `com.apple.developer.associated-domains`. Verify with `security cms -D -i packages/desktop/build/embedded.provisionprofile | plutil -p -` (see step 2).

### `swcutil dl` shows stale negative cache after deploy

Apple's `swcd` cached a "no AASA" response. The cache is 8 days. Force-refresh on the test machine with `sudo swcutil reset` (nuclear) or wait it out. In production, accept the warm-up window + rely on the splash custom-scheme fallback (per D7).

### Universal Link clicks open Safari instead of OpenKnowledge

1. Run `sudo swcutil dl -d openknowledge.ai` — if the response shows entries for the bundle ID, AASA propagated correctly.
2. Verify `OpenKnowledge.app/Contents/embedded.provisionprofile` exists in the packaged app.
3. Verify the entitlement landed via `codesign -d --entitlements - 'OpenKnowledge.app'`.
4. Check console.app for `LSOpenURLsWithRole error -10810` — that means `NSUserActivityTypes` is missing from Info.plist.

### Renderer-side: `continue-activity` fires but receive dialog doesn't render

Renderer log should show `[receive] action=continue-activity-received type=NSUserActivityTypeBrowsingWeb url-host=openknowledge.ai` followed by `[receive] action=url-parse source=universal-link result=ok`. If the first line is missing, the listener in `packages/desktop/src/main/url-scheme.ts` isn't registering — check that `app.on('continue-activity', ...)` runs BEFORE `app.whenReady()`. If the second line is missing, the URL didn't pass `parseShareUrl` validation — check the URL shape against the host gate.

## Cross-reference: what each story landed

- **US-008** — AASA route handler at `docs/src/app/.well-known/apple-app-site-association/route.ts` (PR #965 on the worktree-aasa-file branch). Serves the JSON AASA file from `openknowledge.ai` + `www.openknowledge.ai`.
- **US-011** — `parseShareUrl` decoder in `packages/desktop/src/main/url-scheme.ts` accepts `https://openknowledge.ai/d/<encoded>` Universal Link URLs alongside `openknowledge://share?url=<blob-url>` custom-scheme URLs.
- **US-012** — `app.on('continue-activity', ...)` listener in `packages/desktop/src/main/url-scheme.ts` registers the Handoff event handler. `mac.extendInfo.NSUserActivityTypes` in `electron-builder.yml` declares the supported activity type.
- **US-014** — Receiver-side Q1/Q2/Q3 dialog in `packages/app/src/components/ShareReceiveDialog.tsx` consumes the IPC payload + dispatches into the editor.
- **US-015 (this story)** — Activates Universal Links by adding the entitlement plist line + electron-builder `mac.provisioningProfile` setting + this runbook.
