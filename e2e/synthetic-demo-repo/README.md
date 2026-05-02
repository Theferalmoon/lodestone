# Lodestone Synthetic Demo Repo

Hand-built fixture exercised by `e2e/run-e2e.ts`. Five-language coverage
(TypeScript, JavaScript, Python, Go, Rust) with deterministic call graphs,
import edges, and class hierarchies so the parsers, graph builder,
clusterer, seed-skill scanners, and every MCP tool have meaningful work to
do without depending on an external repo (whose drift would constantly
break our E2E snapshots).

See `FIXTURE_MANIFEST.json` for the full list of expected outputs the e2e
asserts against.
