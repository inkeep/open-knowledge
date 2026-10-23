const { closeSync, fstatSync, open, readSync } = require('node:fs');

const [path, flags] = process.argv.slice(2);

function printOpened(error, fd) {
  if (error) throw error;
  const bytes = Buffer.alloc(fstatSync(fd).size);
  const length = readSync(fd, bytes, 0, bytes.length, 0);
  closeSync(fd);
  process.stdout.write(bytes.subarray(0, length).toString('utf8'));
}

if (flags === undefined) open(path, printOpened);
else open(path, flags, printOpened);
