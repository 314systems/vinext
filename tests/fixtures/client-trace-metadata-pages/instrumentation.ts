export function register() {
  Reflect.set(globalThis, Symbol.for("opentelemetry.js.api.1"), {
    version: "1.9.0",
    context: { active: () => ({}) },
    propagation: {
      inject(
        _context: unknown,
        carrier: unknown,
        setter: { set(c: unknown, key: string, value: string): void },
      ) {
        setter.set(carrier, "my-test-key-1", "my-test-value-1");
        setter.set(carrier, "my-test-key-2", "my-test-value-2");
        setter.set(carrier, "non-metadata-key-3", "non-metadata-key-3");
        setter.set(carrier, "my-parent-span-id", "abc123def4567890");
      },
    },
  });
}
