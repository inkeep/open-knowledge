---
'@inkeep/open-knowledge': patch
---

Adding a frontmatter property now knows what the document's schema declares.

The **Add properties** button already counted the schema-required properties a
document was missing, but clicking it opened one blank row — you still had to go
read the schema and retype every name it had already stated. It now stages a
pre-named row for each missing property, with the widget type taken from the
schema and the cursor in the first value. Nothing is written until you fill a
row in and add it, so a half-finished batch never leaves empty properties behind
(and never clears the "required" warning with a blank value).

The name field on any add-row also offers the fields the governing schemas
declare — filtered as you type, showing each field's type and description, and
marking the required ones. Picking one fills in the name and its type together.
It stays a free-text field: schemas don't own the whole vocabulary, and a
document governed by no schema is unchanged. Enum-constrained fields now offer
their vocabulary while being added, not only after.
