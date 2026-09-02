---
"@inkeep/open-knowledge": patch
---

Agent `exec` can no longer write to the project.

`exec` is documented read-only, and that promise was enforced by comparing each argument against a list of blocked flags. The comparison was exact, so it caught `sort -o notes.md` and missed `sort -onotes.md` — the same flag with its value attached, which `sort` accepts. A command that only reads was able to create a file, and to replace an existing document with the contents of another:

```
sort -oimportant.md other.md
```

Nothing about that goes through `write` or `edit`, so the replacement carried no attribution and left no history to restore from.

`sort` is the only one of the ten allowed commands whose `-o` writes, so the guard is scoped to it and now covers the flag however it is spelled, including bundled forms like `-ro`. `--output-delimiter`, which only changes how output is printed, keeps working. A bare `-o` on its own stays refused for every command, as it was before this change, so `grep -o` still asks for `--only-matching` instead; the clustered forms it appears in, such as `grep -oE`, are unaffected.

A companion suite runs every write and delete attempt we know of through the real command pipeline and asserts the project is byte-identical afterwards, so the read-only promise is checked rather than assumed.
