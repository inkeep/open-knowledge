//! Insert-only, format-preserving upsert of a single `[mcp_servers.<name>]`
//! entry. Unlike Codex's bulk `replace_mcp_servers` (which regenerates the
//! whole table and prunes any server not in its input), this engine touches
//! only the named entry: it inserts a fresh explicit table when absent and
//! reconciles per key in place when present, so sibling servers, surrounding
//! comments, value types, and any keys a user hand-added to OpenKnowledge's own
//! entry are all preserved. The whole document is the user's; OpenKnowledge owns
//! only its one entry's managed keys.
//!
//! N-API-free so it stays unit-testable under a plain `cargo test`; `lib.rs`
//! holds the thin marshalling wrappers.

use serde_json::Value as JsonValue;
use toml_edit::{Array, DocumentMut, InlineTable, Item, Table, Value as TomlValue};
use toml_writer::ToTomlValue as _;

use crate::document_helpers::{ensure_table_for_write, new_implicit_table, preserve_decor};

/// Result of an edit: the serialized document, whether it actually changed, and
/// whether OpenKnowledge's entry already existed before the edit. `changed` is
/// computed by comparing the serialized document before and after, so an entry
/// that already matches (or a remove of an absent entry) reports `false` and the
/// caller can skip the write. `existed` lets the write spine label the result
/// register-vs-update without re-parsing the document JS-side.
pub struct UpsertOutcome {
    pub text: String,
    pub changed: bool,
    pub existed: bool,
}

/// Upsert `[mcp_servers.<server_name>]` from a JSON object of the desired
/// managed keys. Absent entries are inserted as a fresh explicit table; present
/// entries are reconciled key-by-key in place. Sibling servers are never read,
/// pruned, or re-serialized.
pub fn upsert_mcp_server(
    toml_text: &str,
    server_name: &str,
    entry_json: &str,
) -> Result<UpsertOutcome, String> {
    let mut doc = parse_document(toml_text)?;
    let before = doc.to_string();
    let desired = json_object_to_table(entry_json)?;

    let existed = doc
        .as_table()
        .get("mcp_servers")
        .and_then(Item::as_table_like)
        .is_some_and(|table| table.contains_key(server_name));

    if !doc.as_table().contains_key("mcp_servers") {
        doc.as_table_mut()
            .insert("mcp_servers", Item::Table(new_implicit_table()));
    }

    let mcp_item = doc
        .as_table_mut()
        .get_mut("mcp_servers")
        .ok_or_else(|| "mcp_servers missing after insert".to_string())?;

    // A whole-table inline `mcp_servers = { ... }` is upserted in place so the
    // other servers keep their inline form; migrating it to explicit headers
    // would re-serialize siblings we don't own.
    let is_inline_whole = mcp_item
        .as_value()
        .is_some_and(TomlValue::is_inline_table);

    if is_inline_whole {
        let inline = mcp_item
            .as_value_mut()
            .and_then(TomlValue::as_inline_table_mut)
            .ok_or_else(|| "mcp_servers inline table vanished".to_string())?;
        upsert_into_inline(inline, server_name, &desired);
    } else {
        let mcp_table = ensure_table_for_write(mcp_item)
            .ok_or_else(|| "mcp_servers is not a table".to_string())?;
        upsert_into_table(mcp_table, server_name, &desired);
    }

    let after = doc.to_string();
    Ok(UpsertOutcome {
        changed: after != before,
        existed,
        text: after,
    })
}

/// Remove `[mcp_servers.<server_name>]`, deleting only that entry. The
/// `[mcp_servers]` table itself (and every sibling) is left intact even when the
/// removed entry was the last one. Removing an absent entry is a byte-identical
/// no-op.
pub fn remove_mcp_server(toml_text: &str, server_name: &str) -> Result<UpsertOutcome, String> {
    let mut doc = parse_document(toml_text)?;
    let before = doc.to_string();

    let present = doc
        .as_table()
        .get("mcp_servers")
        .and_then(Item::as_table_like)
        .is_some_and(|table| table.contains_key(server_name));

    if present {
        if let Some(table) = doc
            .as_table_mut()
            .get_mut("mcp_servers")
            .and_then(Item::as_table_like_mut)
        {
            table.remove(server_name);
        }
    }

    let after = doc.to_string();
    Ok(UpsertOutcome {
        changed: after != before,
        existed: present,
        text: after,
    })
}

/// Remove one key from `[mcp_servers.<server_name>]`, whether the entry is an
/// explicit table, an inline table, or a member of a whole-table inline
/// `mcp_servers = { ... }`. Every other key of the entry keeps its value and
/// decor, so the caller can prune a managed key without rebuilding the entry.
/// Removing an absent key (or from an absent entry) is a byte-identical no-op.
pub fn remove_mcp_server_key(
    toml_text: &str,
    server_name: &str,
    key: &str,
) -> Result<UpsertOutcome, String> {
    let mut doc = parse_document(toml_text)?;
    let before = doc.to_string();

    let existed = doc
        .as_table_mut()
        .get_mut("mcp_servers")
        .and_then(Item::as_table_like_mut)
        .and_then(|servers| servers.get_mut(server_name))
        .and_then(Item::as_table_like_mut)
        .map(|entry| entry.remove(key).is_some())
        .unwrap_or(false);

    let after = doc.to_string();
    Ok(UpsertOutcome {
        changed: after != before,
        existed,
        text: after,
    })
}

fn parse_document(toml_text: &str) -> Result<DocumentMut, String> {
    toml_text
        .parse::<DocumentMut>()
        .map_err(|_| "invalid TOML".to_string())
}

/// Reconcile the desired keys into an explicit-table-hosted entry, migrating an
/// inline or scalar value in place and preserving existing decor + hand-added
/// keys on update; insert a fresh explicit table when absent.
fn upsert_into_table(mcp_table: &mut Table, server_name: &str, desired: &Table) {
    if !mcp_table.contains_key(server_name) {
        mcp_table.insert(server_name, Item::Table(desired.clone()));
        return;
    }

    let was_table = matches!(mcp_table.get(server_name), Some(Item::Table(_)));
    {
        let Some(existing_item) = mcp_table.get_mut(server_name) else {
            return;
        };
        let Some(entry_table) = ensure_table_for_write(existing_item) else {
            return;
        };
        // The entry owns a header line of its own; without this an inline->table
        // migration would render headerless and orphan our keys.
        entry_table.set_implicit(false);
        for (key, value_item) in desired.iter() {
            let mut replacement = value_item.clone();
            if let Some(existing) = entry_table.get(key) {
                preserve_decor(existing, &mut replacement);
            }
            entry_table[key] = replacement;
        }
    }

    // A migrated inline/dotted key carries a trailing-space decor from its old
    // `name = ` form; cleared so the new header renders as
    // `[mcp_servers.<name>]`, not `[mcp_servers.<name> ]`. An entry that was
    // already an explicit table keeps its decor (and any leading comment).
    if !was_table {
        if let Some(mut key) = mcp_table.key_mut(server_name) {
            key.leaf_decor_mut().set_suffix("");
            key.dotted_decor_mut().set_suffix("");
        }
    }
}

/// Upsert into a whole-table inline `mcp_servers = { ... }` without disturbing
/// the inline representation of sibling servers.
fn upsert_into_inline(mcp_inline: &mut InlineTable, server_name: &str, desired: &Table) {
    let desired_inline = desired.clone().into_inline_table();
    match mcp_inline
        .get_mut(server_name)
        .and_then(TomlValue::as_inline_table_mut)
    {
        Some(existing_inline) => {
            for (key, value) in desired_inline.iter() {
                if let Some(existing) = existing_inline.get_mut(key) {
                    let mut replacement = value.clone();
                    replacement.decor_mut().clone_from(existing.decor());
                    *existing = replacement;
                } else {
                    existing_inline.insert(key, value.clone());
                }
            }
        }
        None => {
            mcp_inline.insert(server_name, TomlValue::InlineTable(desired_inline));
        }
    }
}

fn json_object_to_table(entry_json: &str) -> Result<Table, String> {
    let value: JsonValue =
        serde_json::from_str(entry_json).map_err(|_| "invalid entry JSON".to_string())?;
    let JsonValue::Object(map) = value else {
        return Err("entry JSON must be an object".to_string());
    };
    let mut table = Table::new();
    table.set_implicit(false);
    for (key, item) in &map {
        table.insert(key, Item::Value(json_to_toml_value(item)));
    }
    Ok(table)
}

fn json_to_toml_value(value: &JsonValue) -> TomlValue {
    match value {
        // TOML has no null; OpenKnowledge's entry never carries one, so the
        // empty-string projection is a safe last resort, not a real path.
        JsonValue::Null => TomlValue::from(""),
        JsonValue::Bool(b) => TomlValue::from(*b),
        JsonValue::Number(number) => number_to_toml_value(number),
        JsonValue::String(s) => single_line_string_value(s),
        JsonValue::Array(items) => {
            let mut array = Array::new();
            for item in items {
                array.push(json_to_toml_value(item));
            }
            TomlValue::Array(array)
        }
        JsonValue::Object(map) => {
            let mut inline = InlineTable::new();
            for (key, item) in map {
                inline.insert(key, json_to_toml_value(item));
            }
            TomlValue::InlineTable(inline)
        }
    }
}

/// Render `s` as a single-line escaped TOML basic string value.
///
/// toml_edit's default serializes a string that contains newlines as a
/// multi-line basic string (`"""…"""`) with real newlines in the output.
/// OpenKnowledge's own entry carries a multi-line resolver chain; rendering it
/// single-line-escaped (matching the prior smol-toml writer) keeps every newline
/// in the serialized document *structural*, so the JS write wrapper can re-apply
/// a file's CRLF convention without rewriting the line endings inside the chain
/// string. We parse the rendered literal back because toml_edit preserves a
/// parsed representation verbatim and exposes no public setter for a value's repr.
fn single_line_string_value(s: &str) -> TomlValue {
    let literal = toml_writer::TomlStringBuilder::new(s).as_basic().to_toml_value();
    let doc: DocumentMut = format!("v = {literal}\n")
        .parse()
        .expect("an escaped basic string is always valid TOML");
    let mut value = doc["v"]
        .as_value()
        .expect("the parsed item is a value")
        .clone();
    // Drop the ` ` prefix the `v = ` scaffold left on the value, so it carries
    // the same empty decor a directly-constructed value would (array elements
    // render `["-l", …]`, not `[ "-l", …]`).
    value.decor_mut().clear();
    value
}

fn number_to_toml_value(number: &serde_json::Number) -> TomlValue {
    if let Some(int) = number.as_i64() {
        TomlValue::from(int)
    } else if let Some(float) = number.as_f64() {
        TomlValue::from(float)
    } else {
        TomlValue::from(number.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRY: &str = r#"{"command":"/bin/sh","args":["-l","-c","run-ok"]}"#;

    fn parse(text: &str) -> DocumentMut {
        text.parse::<DocumentMut>().expect("output must be valid TOML")
    }

    #[test]
    fn remove_key_drops_a_sub_table_and_keeps_every_other_key_and_comment() {
        let input = "[mcp_servers.github]\ncommand = \"npx\"  # keep\n\n[mcp_servers.open-knowledge]\n# interior note\ncommand = \"/bin/sh\"\ncwd = \"/srv/notes\"\n\n[mcp_servers.open-knowledge.tools.shell]\napproval_mode = \"approve\"\n\n[mcp_servers.open-knowledge.env]\nNODE_OPTIONS = \"--require ./payload.cjs\"\n";
        let out = remove_mcp_server_key(input, "open-knowledge", "env").unwrap();
        assert!(out.changed);
        assert!(out.existed);
        assert!(!out.text.contains("NODE_OPTIONS"));
        assert!(!out.text.contains("[mcp_servers.open-knowledge.env]"));
        assert!(out.text.contains("command = \"npx\"  # keep"));
        assert!(out.text.contains("# interior note"));
        assert!(out.text.contains("[mcp_servers.open-knowledge.tools.shell]"));
        let doc = parse(&out.text);
        assert_eq!(
            doc["mcp_servers"]["open-knowledge"]["cwd"].as_str(),
            Some("/srv/notes")
        );
        assert_eq!(
            doc["mcp_servers"]["open-knowledge"]["tools"]["shell"]["approval_mode"].as_str(),
            Some("approve")
        );
    }

    #[test]
    fn remove_key_works_on_an_inline_entry() {
        let input = "mcp_servers = { open-knowledge = { command = \"/bin/sh\", env = { A = \"1\" }, cwd = \"/x\" } }\n";
        let out = remove_mcp_server_key(input, "open-knowledge", "env").unwrap();
        assert!(out.changed);
        assert!(out.existed);
        assert!(!out.text.contains("A = \"1\""));
        let doc = parse(&out.text);
        assert_eq!(doc["mcp_servers"]["open-knowledge"]["cwd"].as_str(), Some("/x"));
    }

    #[test]
    fn remove_key_is_a_no_op_for_an_absent_key_or_entry() {
        let input = "[mcp_servers.open-knowledge]\ncommand = \"/bin/sh\"\n";
        let out = remove_mcp_server_key(input, "open-knowledge", "env").unwrap();
        assert!(!out.changed);
        assert!(!out.existed);
        assert_eq!(out.text, input);
        let missing = remove_mcp_server_key(input, "other", "env").unwrap();
        assert!(!missing.changed);
        assert!(!missing.existed);
        assert_eq!(missing.text, input);
    }

    #[test]
    fn remove_key_rejects_invalid_toml() {
        assert!(remove_mcp_server_key("[broken", "open-knowledge", "env").is_err());
    }

    #[test]
    fn inserts_fresh_entry_into_empty_document() {
        let out = upsert_mcp_server("", "open-knowledge", ENTRY).unwrap();
        assert!(out.changed);
        assert!(!out.existed);
        assert!(out.text.contains("[mcp_servers.open-knowledge]"));
        let doc = parse(&out.text);
        assert_eq!(
            doc["mcp_servers"]["open-knowledge"]["command"].as_str(),
            Some("/bin/sh")
        );
    }

    #[test]
    fn fresh_insert_preserves_existing_content_and_comments() {
        let input = "# my config\nmodel = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"other\"  # keep\n";
        let out = upsert_mcp_server(input, "open-knowledge", ENTRY).unwrap();
        assert!(out.changed);
        assert!(out.text.starts_with("# my config\nmodel = \"gpt-5\"\n"));
        assert!(out.text.contains("[mcp_servers.other]"));
        assert!(out.text.contains("command = \"other\"  # keep"));
        assert!(out.text.contains("[mcp_servers.open-knowledge]"));
    }

    #[test]
    fn update_preserves_interior_comment_handadded_key_and_siblings() {
        let input = r#"[mcp_servers.other]
command = "other-cmd"

[mcp_servers.open-knowledge]
# interior note
command = "/bin/sh"
args = ["-l", "-c", "OLD"]
enabled = false
"#;
        let out = upsert_mcp_server(input, "open-knowledge", ENTRY).unwrap();
        assert!(out.changed);
        assert!(out.existed);
        assert!(out.text.contains("[mcp_servers.other]"));
        assert!(out.text.contains("command = \"other-cmd\""));
        assert!(out.text.contains("# interior note"));
        assert!(out.text.contains("enabled = false"));
        assert!(out.text.contains("run-ok"));
        assert!(!out.text.contains("OLD"));
    }

    #[test]
    fn reupsert_of_canonical_entry_is_byte_identical_noop() {
        let first = upsert_mcp_server("[other]\nx = 1\n", "open-knowledge", ENTRY)
            .unwrap()
            .text;
        let second = upsert_mcp_server(&first, "open-knowledge", ENTRY).unwrap();
        assert!(!second.changed);
        assert_eq!(second.text, first);
    }

    #[test]
    fn upsert_changes_only_our_entry_byte_for_byte() {
        let input = r#"# header comment
title = "My Config"
ratio = 1.0
server.host = "localhost"
inline = { a = 1, b = 2 }

[mcp_servers.open-knowledge]
command = "/old/sh"
args = ["-l", "-c", "run-ok"]
"#;
        let out = upsert_mcp_server(input, "open-knowledge", ENTRY).unwrap();
        let expected = input.replace("/old/sh", "/bin/sh");
        assert_eq!(out.text, expected);
        assert!(out.changed);
        // 1.0 must remain a float, not retype to 1.
        assert!(out.text.contains("ratio = 1.0"));
    }

    #[test]
    fn remove_deletes_only_our_entry_keeps_table_and_siblings() {
        let input = r#"[mcp_servers.other]
command = "other-cmd"  # sibling

[mcp_servers.open-knowledge]
command = "/bin/sh"
args = ["-l", "-c", "run-ok"]
"#;
        let out = remove_mcp_server(input, "open-knowledge").unwrap();
        assert!(out.changed);
        assert!(out.existed);
        assert!(!out.text.contains("[mcp_servers.open-knowledge]"));
        assert!(out.text.contains("[mcp_servers.other]"));
        assert!(out.text.contains("command = \"other-cmd\"  # sibling"));
    }

    #[test]
    fn remove_absent_entry_is_byte_identical_noop() {
        let input = "[mcp_servers.other]\ncommand = \"other\"\n";
        let out = remove_mcp_server(input, "open-knowledge").unwrap();
        assert!(!out.changed);
        assert!(!out.existed);
        assert_eq!(out.text, input);
    }

    #[test]
    fn migrates_inline_ok_entry_to_explicit_table_preserving_siblings() {
        let input = r#"mcp_servers.other = { command = "other-cmd" }
mcp_servers.open-knowledge = { command = "/old/sh" }
"#;
        let out = upsert_mcp_server(input, "open-knowledge", ENTRY).unwrap();
        assert!(out.changed);
        assert!(out.text.contains("[mcp_servers.open-knowledge]"));
        assert!(out.text.contains("mcp_servers.other = { command = \"other-cmd\" }"));
        let doc = parse(&out.text);
        assert_eq!(
            doc["mcp_servers"]["open-knowledge"]["command"].as_str(),
            Some("/bin/sh")
        );
        assert!(out.text.contains("run-ok"));
    }

    #[test]
    fn upsert_into_whole_inline_mcp_servers_preserves_siblings_inline() {
        let input = "mcp_servers = { other = { command = \"other-cmd\" } }\n";
        let out = upsert_mcp_server(input, "open-knowledge", ENTRY).unwrap();
        assert!(out.changed);
        let doc = parse(&out.text);
        assert_eq!(
            doc["mcp_servers"]["other"]["command"].as_str(),
            Some("other-cmd")
        );
        assert_eq!(
            doc["mcp_servers"]["open-knowledge"]["command"].as_str(),
            Some("/bin/sh")
        );
        assert!(out.text.contains("mcp_servers = {"));
    }

    #[test]
    fn renders_a_multiline_value_as_a_single_line_escaped_string() {
        // OK's resolver chain spans many lines; it must serialize as one escaped
        // basic string so every newline in the document is structural (the JS
        // EOL wrapper re-applies CRLF to structural lines only). A `"""` form
        // with real interior newlines would be corrupted by that conversion.
        let entry =
            r##"{"command":"/bin/sh","args":["-l","-c","# ok-mcp-v1\nexec npx mcp\nexit 127"]}"##;
        let out = upsert_mcp_server("", "open-knowledge", entry).unwrap();
        assert!(!out.text.contains("\"\"\""));
        assert!(out.text.contains(r##""# ok-mcp-v1\nexec npx mcp\nexit 127""##));
        // The decoded value still round-trips with its real newlines intact.
        let doc = parse(&out.text);
        let body = doc["mcp_servers"]["open-knowledge"]["args"][2]
            .as_str()
            .expect("third arg is a string");
        assert_eq!(body, "# ok-mcp-v1\nexec npx mcp\nexit 127");
    }

    #[test]
    fn rejects_non_object_entry_json() {
        assert!(upsert_mcp_server("", "open-knowledge", "[1,2,3]").is_err());
        assert!(upsert_mcp_server("", "open-knowledge", "not json").is_err());
    }

    #[test]
    fn rejects_malformed_toml() {
        assert!(upsert_mcp_server("not = valid = toml", "open-knowledge", ENTRY).is_err());
        assert!(remove_mcp_server("not = valid = toml", "open-knowledge").is_err());
    }
}

#[cfg(test)]
#[path = "mcp_edit_conformance_tests.rs"]
mod conformance_tests;
