use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

pub fn require_declared_rustc() {
    let manifest_dir = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR for build scripts"),
    );
    let declaration = manifest_dir
        .join("..")
        .join("..")
        .join("rust-toolchain.toml");
    println!("cargo:rerun-if-changed={}", declaration.display());
    println!("cargo:rerun-if-env-changed=RUSTUP_TOOLCHAIN");
    let release = compiler_release();
    let channel = fs::read_to_string(&declaration).map(|text| declared_channel(&text));
    let problem = match &channel {
        Err(error) => format!("cannot read the Rust toolchain declaration: {}", error),
        Ok(None) => "the Rust toolchain declaration names no channel under [toolchain]".to_string(),
        Ok(Some(channel)) if !is_exact_release(channel) => format!(
            "the declared channel \"{}\" is not an exact MAJOR.MINOR.PATCH release",
            channel
        ),
        Ok(Some(channel)) if *channel != release => {
            format!(
                "rustc {} is not the declared Rust release {}",
                release, channel
            )
        }
        Ok(Some(_)) => return,
    };
    let declared = match &channel {
        Ok(Some(channel)) => channel.as_str(),
        _ => "none",
    };
    let shown = fs::canonicalize(&declaration).unwrap_or_else(|_| declaration.clone());
    eprintln!(
        "error: {}\n  compiler release: {}\n  declared channel: {}\n  declaration: {}\nhelp: build with rustup (https://rustup.rs) from the directory that holds the declaration, or one below it, so rustup installs and selects the declared toolchain. Any of these selects another compiler and must go: a RUSTUP_TOOLCHAIN variable, a +toolchain argument, a `rustup override` set on that directory, or a cargo or rustc earlier on PATH that rustup does not manage (such as a Homebrew, distribution or Nix install). The declaration names one exact release as channel = \"MAJOR.MINOR.PATCH\" under [toolchain]",
        problem,
        release,
        declared,
        shown.display()
    );
    std::process::exit(1);
}

fn compiler_release() -> String {
    let rustc = env::var_os("RUSTC").expect("cargo sets RUSTC for build scripts");
    let output = Command::new(&rustc)
        .arg("-vV")
        .output()
        .expect("cargo runs $RUSTC -vV before any build script");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix("release: "))
        .expect("cargo requires a release line from $RUSTC -vV")
        .trim()
        .to_string()
}

fn declared_channel(text: &str) -> Option<String> {
    let mut in_toolchain_table = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_toolchain_table = table_name(line) == Some("toolchain");
        } else if in_toolchain_table {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim() == "channel" {
                    return Some(string_value(value.trim()));
                }
            }
        }
    }
    None
}

fn table_name(header: &str) -> Option<&str> {
    let inner = header.strip_prefix('[')?;
    let end = inner.find(']')?;
    Some(inner[..end].trim())
}

fn string_value(raw: &str) -> String {
    let mut characters = raw.chars();
    match characters.next() {
        Some(quote) if quote == '"' || quote == '\'' => characters
            .take_while(|character| *character != quote)
            .collect(),
        _ => raw.to_string(),
    }
}

fn is_exact_release(channel: &str) -> bool {
    let parts: Vec<&str> = channel.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}
