---
name: mcp-protocol
description: Where to find authoritative Model Context Protocol facts for Tributary — the 2026-07-28 and 2025-11-25 specifications and schemas, the pinned MCP Java SDK, official TypeScript and Python SDKs, and the official conformance suite with its commands. Use before writing, testing or deciding anything about MCP wire behavior (MRTR, input_required, elicitation, server/discover, headers, error codes, sessions, transports).
---

# MCP protocol reference

Tributary's correctness claims are protocol claims, so they rest on the specification and on observed runs, never on memory. Wire details changed substantially between versions; anything recalled without a source is a guess.

## Versions in play

| Role | Version |
| --- | --- |
| Front (what clients see) | MCP **2026-07-28**: stateless requests, no `initialize` handshake or `Mcp-Session-Id`, `server/discover`, multi round-trip requests (`input_required` with `inputRequests` and `requestState`, client retries with `inputResponses`), `Mcp-Method` and `Mcp-Name` headers |
| Legacy backends (bridged) | MCP **2025-11-25**: `initialize` handshake, sessions, server-initiated `elicitation/create` callbacks |

How each change maps onto Tributary is in the scope doc, section "Design basis: MCP 2026-07-28". Read it before the spec: it says which parts matter here.

## Authoritative sources

- Specification 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28 — subpages `/architecture`, `/basic`, `/server`, `/client`.
- Specification 2025-11-25: https://modelcontextprotocol.io/specification/2025-11-25
- Schemas (the normative types): https://github.com/modelcontextprotocol/specification/tree/main/schema — `2026-07-28/schema.ts`, `2025-11-25/schema.ts`.
- Page index for finding the right section quickly: https://modelcontextprotocol.io/llms.txt
- Extensions (Tasks is one; out of scope for 0.1): https://modelcontextprotocol.io/extensions/overview

Cite the spec page and section, or the schema type, for every protocol behavior you implement, test or decide.

## Java SDK

- Repository: https://github.com/modelcontextprotocol/java-sdk — read the release notes and source for the exact pinned version, not `main`.
- The pin is `mcp-sdk.version` in the parent `pom.xml` (currently `2.2.0`, GA). Roadmap task T0A-2 recorded what it provides, read in the source at the tag: a modern 2026-07-28 server and a modern client (both preview APIs that may change in minor releases until 3.0), SEP-2243 standard header validation on the server, and no Tasks. It pulls `reactor-core` 3.9.0-RC1. The legacy client's session-wide `requestTimeout` (20 s by default) also covers the time a user takes to answer an elicitation, so a parked call needs it raised. T0A-9 records the final pin decision.
- Server conformance is not end-to-end interoperability. Only a run through real clients and servers shows the latter.

## Official clients and servers for wire tests

Gate A needs an official 2026-07-28 client in TypeScript or Python, and Gate E needs golden vectors verified in a second language.

- TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk (npm `@modelcontextprotocol/sdk`)
- Python SDK: https://github.com/modelcontextprotocol/python-sdk (PyPI `mcp`)

Pin exact versions (a lockfile, or `==` in requirements) and record them in the evidence file. Support for 2026-07-28 started as beta releases; check each SDK's release notes for the version that implements what the test needs.

## Conformance suite

Official suite: https://github.com/modelcontextprotocol/conformance

```bash
npx @modelcontextprotocol/conformance list --server                    # available server scenarios
npx @modelcontextprotocol/conformance list --requirements 2026-07-28   # what that revision requires
npx @modelcontextprotocol/conformance server --url http://localhost:<port>/mcp
npx @modelcontextprotocol/conformance server --url http://localhost:<port>/mcp --requirements 2026-07-28
npx @modelcontextprotocol/conformance server --url http://localhost:<port>/mcp --scenario <name> --verbose
```

- Pin the package version (`npx @modelcontextprotocol/conformance@<version>`) in scripts and CI so results are reproducible.
- Known failures go in a baseline file passed with `--expected-failures conformance-baseline.yml`; each entry is a scenario or `scenario:check-id` (no space after the colon). Every baseline entry needs a reason in the PR; an entry is never a way to pass a gate silently.
- In CI, use the action `modelcontextprotocol/conformance` (pin it to a commit SHA) with `mode: server` and `url:` after starting the server.

## Rules

- Never infer wire behavior from another implementation's code alone; confirm with the spec and a captured exchange.
- A 2026-07-28 client talking directly to a 2025 server falls back to the old handshake. Tests of the bridge must put Tributary between them, or they prove nothing.
- Error codes and messages must match the scope doc's wire table, validated against the spec and the conformance suite (task T0A-8). Keep "unknown stays unknown" in every message.
