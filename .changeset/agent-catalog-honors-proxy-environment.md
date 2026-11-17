---
'@inkeep/open-knowledge-server': patch
---

The Agent Catalog now loads through the proxy set in `HTTPS_PROXY` or `HTTP_PROXY`, and reaches hosts listed in `NO_PROXY` directly, instead of failing on networks that only allow outbound traffic through a proxy. [Set the variables where OpenKnowledge is launched](https://openknowledge.ai/docs/features/editor#agent-catalog-behind-a-proxy); the system proxy setting is not used.
