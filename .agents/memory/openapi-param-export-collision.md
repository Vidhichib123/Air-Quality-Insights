---
name: OpenAPI parameter export collision
description: Orval can emit a duplicate parameter symbol when an operation combines path and query parameters.
---

When an operation combines path and query parameters, this workspace's generated API package can export the same operation-specific `*Params` name for both a Zod schema and a TypeScript type. Code generation may succeed, then the library typecheck fails with TS2308.

**Why:** The generated barrel star-exports both modules, and the generator uses the same name for these parameter exports.

**How to apply:** After adding parameterized operations, run codegen and inspect the generated exports. For simple read-only endpoints, putting an identifier in the query can avoid this collision; otherwise resolve the export naming explicitly rather than accepting a failing typecheck.
