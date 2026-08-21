---
"@inkeep/open-knowledge": patch
---

Zoom-in on a large Mermaid diagram can now reach 1:1 and past it. Panzoom's `maxScale` was a multiplier on the SVG's already-fit painted size, so a diagram that mermaid shrank to fit the container capped below its natural size. The Mermaid host now divides the ceiling by the fit ratio, so `MERMAID_ZOOM_MAX` behaves as "max natural zoom" regardless of the diagram's size.
