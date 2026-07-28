/**
 * electron-builder `beforeBuild` hook.
 *
 * Return value contract (app-builder-lib Packager.installAppDependencies):
 * `false` skips the @electron/rebuild native-dependency pass; any other value
 * lets it run. We gate it on the build host platform (each platform packages on
 * its own native runner, so host === target here).
 *
 * macOS + Windows → run the rebuild. macOS ships node-pty (a node-gyp/nan addon,
 * NOT N-API) which must be rebuilt for Electron's ABI; Windows cross-builds the
 * per-arch native binaries (its arm64 installer needs them) and compiles cleanly
 * under MSVC.
 *
 * Linux → skip it. Every native module that actually ships in the Linux package
 * is N-API and loads in Electron straight from its prebuilt `.node` with no
 * rebuild: @napi-rs/keyring, @inkeep/open-knowledge-native-config, and
 * @parcel/watcher. node-pty is excluded from the Linux `files`. The only reason
 * @electron/rebuild has anything to compile is unused node-gyp transitive deps
 * dragged in through the bundled server (node-liblzma via just-bash,
 * @mongodb-js/zstd) — pnpm ignores their build scripts, so they are unbuilt in
 * every normal install and the app already runs without them. Compiling them
 * adds nothing and hard-fails on Linux GCC: node-liblzma's binding.gyp forces
 * `-Werror`, and Electron's bundled v8 headers trip `-Wcomment` (ASCII-art
 * comments ending in `\`). Skipping the pass keeps the Linux draft build green.
 */
export default async function beforeBuild() {
  return process.platform !== 'linux';
}
