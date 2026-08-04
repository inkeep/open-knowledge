---
'@inkeep/open-knowledge': patch
---

Images with a missing `src` (404, broken URL, deleted asset) now render a visible placeholder card — icon + "Image failed to load" + the truncated path — instead of leaving the reader with the browser's default 16×16 broken-image glyph. Same behavior on cached-broken images that fail before onError fires (detected via `img.complete && naturalWidth === 0`). Placeholder stays inline (`<span>`) so it's safe inside `<p>` and inside `<Zoom wrapElement="span">`.
