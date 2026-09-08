//! N-API surface for OpenKnowledge's native harness-config engine.
//!
//! This crate exists because every maintained JavaScript TOML library destroys
//! comments and reflows formatting on a round-trip, and OpenKnowledge must add
//! only its own `[mcp_servers.open-knowledge]` entry to a user's Codex config
//! without touching anything else. `toml_edit` is a format-preserving document
//! model; this addon wraps the slice of it the write/classify spine needs.
//!
//! The real logic lives in N-API-free modules so it stays unit-testable under a
//! plain `cargo test`; the functions here are thin marshalling wrappers.

use napi_derive::napi;

mod document_helpers;
mod mcp_edit;
mod path_resolve;
mod toml_json;

use std::path::Path;

/// Parse TOML text and return its data projected to a JSON string.
///
/// Throws a JS exception only for genuinely-unparseable input. See
/// `toml_json::parse_toml_to_json` for the capability and lossiness contract.
#[napi]
pub fn parse_toml_to_json(toml_text: String) -> napi::Result<String> {
    toml_json::parse_toml_to_json(&toml_text).map_err(napi::Error::from_reason)
}

/// The serialized document, whether the edit actually changed it (so the JS
/// write spine can skip a write and its backup on a no-op), and whether OK's
/// entry already existed (so the spine labels register-vs-update without
/// re-parsing).
#[napi(object)]
pub struct McpEditResult {
    pub text: String,
    pub changed: bool,
    pub existed: bool,
}

/// Insert or update only `[mcp_servers.<server_name>]` from a JSON object of the
/// entry's managed keys, preserving every other document token. Throws only for
/// unparseable TOML or a non-object entry payload.
#[napi]
pub fn upsert_mcp_server(
    toml_text: String,
    server_name: String,
    entry_json: String,
) -> napi::Result<McpEditResult> {
    let outcome = mcp_edit::upsert_mcp_server(&toml_text, &server_name, &entry_json)
        .map_err(napi::Error::from_reason)?;
    Ok(McpEditResult {
        text: outcome.text,
        changed: outcome.changed,
        existed: outcome.existed,
    })
}

/// Remove only `[mcp_servers.<server_name>]`, never the surrounding table.
/// Throws only for unparseable TOML.
// Exposed for the future `ok uninstall` flow; NativeTomlBinding intentionally omits it until then.
#[napi]
pub fn remove_mcp_server(toml_text: String, server_name: String) -> napi::Result<McpEditResult> {
    let outcome =
        mcp_edit::remove_mcp_server(&toml_text, &server_name).map_err(napi::Error::from_reason)?;
    Ok(McpEditResult {
        text: outcome.text,
        changed: outcome.changed,
        existed: outcome.existed,
    })
}

/// Remove one key from `[mcp_servers.<server_name>]`, leaving every other key
/// of the entry and its decor in place. Throws only for unparseable TOML.
#[napi]
pub fn remove_mcp_server_key(
    toml_text: String,
    server_name: String,
    key: String,
) -> napi::Result<McpEditResult> {
    let outcome = mcp_edit::remove_mcp_server_key(&toml_text, &server_name, &key)
        .map_err(napi::Error::from_reason)?;
    Ok(McpEditResult {
        text: outcome.text,
        changed: outcome.changed,
        existed: outcome.existed,
    })
}

/// Where to read the existing config from and where to write the updated one
/// after following any symlink chain. `read_path` is absent when the chain
/// cycles or can't be resolved, in which case `write_path` is the original path
/// and writing a fresh file there breaks the link.
#[napi(object)]
pub struct SymlinkWritePaths {
    pub read_path: Option<String>,
    pub write_path: String,
}

/// Resolve `path`'s symlink chain to its real write target so the caller writes
/// through a dotfile-managed symlink instead of replacing it. Never touches the
/// filesystem beyond reading link metadata.
#[napi]
pub fn resolve_symlink_write_path(path: String) -> napi::Result<SymlinkWritePaths> {
    let resolved = path_resolve::resolve_symlink_write_paths(Path::new(&path))
        .map_err(|err| napi::Error::from_reason(err.to_string()))?;
    Ok(SymlinkWritePaths {
        read_path: resolved
            .read_path
            .map(|p| p.to_string_lossy().into_owned()),
        write_path: resolved.write_path.to_string_lossy().into_owned(),
    })
}
