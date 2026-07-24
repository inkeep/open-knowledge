---
"@inkeep/open-knowledge": patch
---

Fix cross-app clipboard fidelity for container-nested images that carry a non-portable (relative or document-relative) URL. Copying a component such as a Callout or Accordion that holds a relative-URL image no longer pastes the whole component's markdown source at the image's position in rich-text destinations. The image now contributes only its own source-fallback markdown.

Previously the descriptor resolver climbed past the container's content boundary and treated the enclosing component as the leaf's descriptor, so the entire component source was serialized at the leaf's slot. The climb now stops at the container's content boundary, keeping the resolved range within the leaf's own node view. Copy as plain text and Open Knowledge to Open Knowledge paste were unaffected and remain unchanged.
