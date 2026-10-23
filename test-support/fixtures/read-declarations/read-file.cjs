const { readFileSync } = require('node:fs');

process.stdout.write(readFileSync(process.argv[2], 'utf8'));
