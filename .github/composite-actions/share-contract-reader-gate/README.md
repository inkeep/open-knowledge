# Share contract reader gate

This composite action blocks a release or deployment when the deployed Open Knowledge reader cannot consume the fixed v2 share corpus.

It runs `.github/scripts/probe-share-contract.mjs`, records the contract epoch, corpus digest, deployment SHA, and fixed-case results in the job summary, and uploads the JSON evidence even when the probe fails.

Inputs:

- `origin`: absolute deployment origin to probe.
- `expected-deployment-sha`: optional SHA that the reader manifest must report.
- `evidence-name`: artifact name for the JSON evidence.
