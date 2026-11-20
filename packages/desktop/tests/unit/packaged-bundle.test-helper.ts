export const LIBRARY_NATIVE = 'app.asar.unpacked/node_modules/@inkeep/open-knowledge/dist/native';
export const SOUND_ASAR: readonly string[] = [
  'package.json',
  'out/main/index.js',
  'node_modules/@inkeep/open-knowledge-server/dist/index.mjs',
  'node_modules/@inkeep/open-knowledge-core/dist/index.mjs',
];
export const SOUND_DISK: readonly string[] = [
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'app/index.html',
  'cli/dist/cli.mjs',
  'cli/dist/native/index.js',
  'cli/dist/native/native-config.linux-x64-gnu.node',
  'cli/node_modules/@inkeep/open-knowledge-native-config/index.js',
  'app.asar.unpacked/node_modules/@inkeep/open-knowledge/dist/index.mjs',
  `${LIBRARY_NATIVE}/index.js`,
  `${LIBRARY_NATIVE}/native-config.darwin-arm64.node`,
  'app.asar.unpacked/node_modules/@napi-rs/keyring/index.js',
  'locales/en/messages.json',
];
