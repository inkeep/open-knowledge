const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');

const stateFile = process.env.OK_TEST_STATE_FILE;
const witnessFile = process.env.OK_TEST_STATE_WITNESS;
if (!stateFile || !witnessFile) throw new Error('State publication observation paths are required');

const originalOpen = fs.openSync;
const originalWrite = fs.writeFileSync;
const originalRead = fs.readFileSync;
const matches = (file) => file === stateFile || file === `${stateFile}.pending`;

fs.writeFileSync = (file, data, options) => {
  if (!matches(file) || typeof data !== 'string') return originalWrite(file, data, options);
  const encoding = typeof options === 'string' ? options : (options?.encoding ?? 'utf8');
  return originalWrite(file, Buffer.from(data, encoding), options);
};

fs.openSync = (...args) => {
  const fd = Reflect.apply(originalOpen, fs, args);
  if (!matches(args[0]) || args[1] !== 'w') return fd;
  const contents = fs.existsSync(stateFile) ? originalRead(stateFile, 'utf8') : null;
  originalWrite(witnessFile, JSON.stringify(contents));
  return fd;
};

syncBuiltinESMExports();
