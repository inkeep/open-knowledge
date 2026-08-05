---
"@inkeep/open-knowledge": patch
---

Broken images keep their "Image failed to load" pill, without side effects on copy or on anything else that reads the document. The failed `<img>` now stays mounted (hidden) behind the pill, so copying a selection with a broken relative-path image emits the markdown source-fallback block again instead of silently dropping the image, the pill's own text no longer pastes into other apps as if it were document content, and a broken-but-portable web image pastes as a normal `<img>` whose URL may still resolve at the destination. Error detection now trusts the image's error event alone, so a successfully loaded dimensionless resource (an SVG sized only by CSS) is no longer misreported as broken, and screen readers always hear the failure notice with the image's alt text or source.
