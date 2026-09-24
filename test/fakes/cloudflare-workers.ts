/**
 * Stands in for the `cloudflare:workers` module, which only resolves inside
 * the workerd runtime. Aliased in vitest.config.ts so test/unit (plain Node
 * pool — see the note in that file) can import a Durable Object class and
 * drive its methods directly against a fake `ctx`.
 *
 * Only the base class's ctx/env wiring is reproduced; the RPC plumbing a
 * real `DurableObject` provides is irrelevant when tests call methods on
 * the instance instead of through a stub.
 */
export class DurableObject<E = unknown> {
  constructor(
    readonly ctx: DurableObjectState,
    readonly env: E
  ) {}
}
