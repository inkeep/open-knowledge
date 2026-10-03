#!/usr/bin/env node
const res = await fetch(`http://127.0.0.1:${process.env.PORT || 8080}/readyz`).catch(() => null);
process.exit(res?.ok ? 0 : 1);
