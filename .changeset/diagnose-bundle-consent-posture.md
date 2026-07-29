---
"@inkeep/open-knowledge": minor
---

`ok diagnose bundle` now redacts by default, and the y/N prompt states plainly what leaves your machine before it writes anything.

- **Credentials are scrubbed on every bundle.** GitHub PATs, AWS access keys, Anthropic and OpenAI keys, bearer tokens, JWTs, and URL-embedded credentials are replaced with `[REDACTED-*]` placeholders, and macOS/Linux home-directory paths are anonymized to `~/` (the path hierarchy below the home directory is preserved). `ok diagnose bundle` never ran this scrub before, so bundles produced by earlier versions could carry a live token; `ok bug-report` and the in-app bug report already did.
- **The content directory path is masked** as `<CONTENT_DIR>`, so a shared bundle does not leak your home-directory layout.
- **The flag is now `--no-redact`**, an explicit opt-out that writes a raw bundle for you to inspect locally: no credential scrubbing and no path masking. `--redact` is still accepted and is now simply the default, so existing scripts and muscle memory keep working.
- **Document names ship in cleartext.** The old opt-in `--redact` pass hashed them to `doc:<8hex>` and wrote a `<bundle>.docnames.json` inverse-map sidecar next to the zip; both are gone. Legible document names are what make a bundle diagnosable, so the tradeoff is now an informed one rather than a silent one: the consent summary says "in cleartext" next to the count, and the manifest's `redaction` block no longer carries `docNameMapSidecar` or `docNameCollisions`.
- **The consent summary is now itemized** by what actually leaves the machine: document names, whether the content directory path is masked, and whether credentials were scrubbed (with the line count). Under `--no-redact` it says so in as many words.
- **Bundles carry the content-loss ring** as `state/loss-current.jsonl` and `state/loss-prev.jsonl` when it exists, so a "my edit vanished" report arrives with the evidence attached. The ring is content-free by schema.

- **The desktop app now scrubs captured renderer console output before writing it to `~/.ok/logs`.** Console capture is on by default, and a credential printed to the console previously landed verbatim in that log file for its 7-day retention — the keyed-field redaction in front of the log never inspected the message text. The same scrub also masks `/Users/<name>/` paths to `~/` there, matching what the web build already did on its way to the server log.

The in-app bug report and `ok bug-report` always redact. `ok diagnose bundle` is the only surface with an opt-out.
