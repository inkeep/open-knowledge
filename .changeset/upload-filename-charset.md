---
'@inkeep/open-knowledge': patch
---

Uploaded filenames with non-ASCII characters are no longer mangled. Dragging a file named `café.png` into a document stored it as `cafÃ©.png`; a macOS screenshot, whose name contains a narrow no-break space before AM/PM, arrived as `Screenshot ... 10.48.44â_AM.png`. Non-Latin scripts fared worse still, with `会議メモ.pdf` losing nearly all of its characters. The multipart parser was reading the filename as Latin-1, while browsers and every other conformant client send it as UTF-8, so each multi-byte character was split into one garbled character per byte before anything else in the upload path could see it. Both upload endpoints are affected, asset uploads and skill imports alike.

Files uploaded before this release keep their mangled names. The original name was never recorded anywhere, so there is nothing to restore them from, and the mangling is not reliably reversible. Links and images still resolve, because the stored name and the reference in your document have always matched each other. Renaming the file fixes the display.

One narrow tradeoff: a client that genuinely sends a Latin-1 filename, rather than the UTF-8 that browsers and standard HTTP tooling send, will now have the non-ASCII characters in that name read as unrecognized. An asset upload stores them as underscores; a skill import, which does not run the same name cleanup, keeps them as the standard replacement character. There is no signal on the wire that would let the server tell the two cases apart, and UTF-8 is what browsers and every standard client send.
