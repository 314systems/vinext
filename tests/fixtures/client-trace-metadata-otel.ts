import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import {
  ROOT_CONTEXT,
  context,
  propagation,
  trace,
  type Context,
  type ContextManager,
  type TextMapPropagator,
} from "@opentelemetry/api";

class RequestContextManager implements ContextManager {
  readonly #storage = new AsyncLocalStorage<Context>();

  active(): Context {
    const activeContext = this.#storage.getStore();
    if (activeContext) return activeContext;
    const requestContext = createRequestSpanContext();
    this.#storage.enterWith(requestContext);
    return requestContext;
  }

  with<T, A extends unknown[]>(
    activeContext: Context,
    fn: (...args: A) => T,
    thisArg?: ThisParameterType<(...args: A) => T>,
    ...args: A
  ): T {
    return this.#storage.run(activeContext, () => fn.apply(thisArg, args));
  }

  bind<T>(activeContext: Context, target: T): T {
    if (typeof target !== "function") return target;
    const manager = this;
    return function (this: unknown, ...args: unknown[]) {
      return manager.with(activeContext, target as (...args: unknown[]) => unknown, this, ...args);
    } as T;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.#storage.disable();
    return this;
  }
}

function createRequestSpanContext(): Context {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    traceFlags: 1,
  });
}

const propagator: TextMapPropagator = {
  inject(activeContext, carrier, setter) {
    setter.set(carrier, "my-test-key-1", "my-test-value-1");
    setter.set(carrier, "non-metadata-key-2", "must-not-render");
    const spanContext = trace.getSpanContext(activeContext);
    if (spanContext) setter.set(carrier, "my-parent-span-id", spanContext.spanId);
  },
  extract(activeContext) {
    return activeContext;
  },
  fields() {
    return ["my-test-key-1", "non-metadata-key-2", "my-parent-span-id"];
  },
};

export function registerTestOpenTelemetry(): void {
  context.disable();
  propagation.disable();
  context.setGlobalContextManager(new RequestContextManager());
  propagation.setGlobalPropagator(propagator);
}
