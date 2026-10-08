mod toolchain_guard;

fn main() {
    toolchain_guard::require_declared_rustc();
    napi_build::setup();

    // `napi_build::setup()` only applies `-undefined dynamic_lookup` to the
    // cdylib artifact. The unit-test binary links the same crate, so without
    // this the N-API host symbols it references (but never calls in a test
    // process) would be unresolved at link time on macOS. Allowing dynamic
    // lookup lets `cargo test` link; the symbols are never dereferenced because
    // the tests exercise only the pure projection helpers.
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-arg=-Wl,-undefined,dynamic_lookup");
    }
}
