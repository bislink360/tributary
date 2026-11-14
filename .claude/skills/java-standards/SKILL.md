---
name: java-standards
description: Tributary's Java coding standards — Google Java Style, module and package structure, readability over cleverness, comment policy, error handling, concurrency on virtual threads, and test conventions. Use when writing or reviewing any Java code or Maven build file in this repository.
---

# Tributary Java standards

The baseline is the [Google Java Style Guide](https://google.github.io/styleguide/javaguide.html). This page adds the project's choices and the points reviews most often catch.

## Formatting

- google-java-format, enforced in the build by the Spotless Maven plugin (`spotless:check` runs in `verify`). Run `./mvnw spotless:apply` rather than formatting by hand.
- 2-space indentation, 100-column limit, one top-level class per file, no wildcard imports.

## Structure

- Modules follow the roadmap: `tributary-core` (JDK only, no third-party runtime dependency), `tributary-mcp-adapter` (official MCP Java SDK), `tributary-test-support`, `tributary-examples-java`. `tributary-spike` is Phase 0 exploration and is not a template for production code.
- Packages: `com.bislink360.tributary.<module>.<feature>`, organized by feature (`continuation`, `transport`, `catalog`), not by layer (`service`, `util`, `impl`).
- Smallest visibility that works. Package-private is the default; `public` is a deliberate API decision. Public types in `core` are API and are checked for compatibility.
- Dependency versions live in the parent POM's `dependencyManagement` and `pluginManagement`; modules never declare versions.

## Readable code

The code should explain itself to a reader who has not seen it before.

- Names carry the meaning: `RoundClaim`, `claimRound`, `isTerminal`, not `Manager`, `process`, `flag`, `data`, `tmp`.
- Methods do one thing and fit on a screen; extract a well-named method instead of writing a comment that labels a block.
- Prefer plain control flow over clever constructs: no nested ternaries, no long stream chains with side effects, no reflection or annotation magic where a direct call works.
- No speculative generality: no interface with one implementation unless it is a seam the design names (transport, clock, storage), no configuration options nobody asked for, no "future use" parameters.
- Immutable by default: `record` for values, `final` fields, `List.copyOf` at boundaries. Model closed sets of states with `sealed` interfaces and exhaustive `switch`.
- No dead code, commented-out code or TODOs without a roadmap task id.

## Comments

- Javadoc on every public type and method: what it guarantees, its parameters, its exceptions and its thread-safety. Not how it works.
- Inside method bodies, comment only the *why* that the code cannot say: a protocol rule with a spec link, a race being avoided, a deliberate deviation. Never narrate what the next line does.
- Never restate the method name (`/** Gets the id. */`).

## Errors and nulls

- Validate arguments at public boundaries with `Objects.requireNonNull` and explicit checks; inside, assume validity.
- `Optional` only as a return type. Never return `null` from public methods; never pass `null` to mean "absent".
- Throw specific exceptions with messages that state what was expected and what was received. Never catch and ignore; never catch `Exception` or `Throwable` except at a documented top-level boundary.
- Follow the roadmap's unknown-stays-unknown rule in names and messages: an operation whose outcome is unknown is never called failed, not executed, rolled back or safe to retry.

## Concurrency

- Synchronous code on virtual threads (roadmap D6). Never block an SDK event-loop or callback thread; hand off instead.
- Use `java.util.concurrent` primitives (`ReentrantLock`, `ConcurrentHashMap`, `CompletableFuture`) over `synchronized` and `wait`/`notify`, which pin virtual threads on JDK 21.
- Inject time through a `Clock` or the project's clock seam; never call `System.currentTimeMillis()` or `Instant.now()` directly in logic.
- Logging in `core` uses `System.Logger`; other modules use the SLF4J API. Never log tokens, secrets or user payloads.

## Tests

- JUnit 5. Test classes mirror the production package; names describe behavior: `rejectsResumeFromAnotherPrincipal`.
- Arrange, act, assert, visibly separated by blank lines, without labelling comments.
- Deterministic: no `Thread.sleep`, no real time, no ordering by chance. Use latches, barriers and fake clocks; race tests drive interleavings explicitly.
- One behavior per test; assertions that would fail if the behavior broke. A test that cannot fail is a defect.
- Every bug fix comes with a regression test that failed before the fix.
