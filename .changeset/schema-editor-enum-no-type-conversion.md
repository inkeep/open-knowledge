---
"@inkeep/open-knowledge": patch
---

The frontmatter schema editor no longer re-presents a typed field as an enum when you give it allowed values. Typing into a `string` field's allowed-values box added the values correctly but flipped the field's Type select to `enum`, which read as a silent type change — and switching it back to `string` then deleted the values you had just entered. Allowed values are a constraint, not a type: a field keeps showing its declared type, and the `enum` option now shows only for a field the schema leaves untyped (a bare `{"enum": [...]}`), or while you are explicitly picking it. Picking `enum` no longer writes a `string` type in, and moving a field to `string` keeps its allowed values instead of clearing them. Any other target type still clears them, because it could never satisfy them — a string vocabulary left on a `number` field makes that field reject every possible value. The same rules apply to an array field's element type.
