---
"@inkeep/open-knowledge": patch
---

The project server now exposes standard health-check endpoints: `GET /healthz` answers 200 as soon as the listener is up (process liveness), and `GET /readyz` reports 503 while the project runtime is still initializing, then 200 with a `degraded` list naming any subsystems that failed to start. The moment shutdown begins, `/readyz` flips to 503 with status `draining` so probe-driven routers stop sending traffic before the listener closes. Both endpoints are exempt from the Host/Origin admission checks so container orchestrators and reverse-proxy health probes (which send IP Host headers and traverse proxies) work without configuration.
