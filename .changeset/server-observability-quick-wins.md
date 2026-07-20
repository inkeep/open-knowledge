---
"@inkeep/open-knowledge": patch
---

New operational metrics for cloud/server operators (all zero-overhead when telemetry is disabled): event-loop delay percentiles (`ok.server.event_loop.delay_ms`), CPU utilization (`ok.server.cpu.utilization`), extended memory sections (`external`, `array_buffers`) on `ok.server.memory.usage_megabytes`, a loaded-documents gauge (`ok.server.docs.loaded`), and write-spine queue depths (`ok.persistence.queue.depth`, `ok.bridge.drain_backlog`). Error responses now stamp their correlation UUID on the active trace span (`ok.error.instance`) so a client-reported error can be joined against its trace. The standard `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` sampling contract is now pinned by tests and documented, including its interaction with the local bug-bundle span sink.
