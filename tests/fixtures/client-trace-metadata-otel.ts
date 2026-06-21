import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { ViteDevServer } from "vite";
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
    return this.#storage.getStore() ?? ROOT_CONTEXT;
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

const TEST_OTEL_REGISTRATION = Symbol.for("vinext.test.clientTraceMetadata.otel");

export function registerTestOpenTelemetry(): void {
  if (Reflect.get(globalThis, TEST_OTEL_REGISTRATION)) return;
  context.disable();
  propagation.disable();
  context.setGlobalContextManager(new RequestContextManager());
  propagation.setGlobalPropagator(propagator);
  Reflect.set(globalThis, TEST_OTEL_REGISTRATION, true);
}

export function instrumentTestServerRequests(server: ViteDevServer): void {
  registerTestOpenTelemetry();
  const httpServer = server.httpServer;
  if (!httpServer) throw new Error("Expected fixture server to expose an HTTP server");

  const listeners = httpServer.listeners("request") as RequestListener[];
  if (listeners.length === 0) throw new Error("Expected fixture server to have a request listener");
  for (const listener of listeners) httpServer.removeListener("request", listener);

  httpServer.on("request", (request: IncomingMessage, response: ServerResponse) => {
    const requestContext = createRequestSpanContext();
    context.with(requestContext, () => {
      for (const listener of listeners) listener.call(httpServer, request, response);
    });
  });
}

export function resetTestOpenTelemetry(): void {
  context.disable();
  propagation.disable();
  Reflect.deleteProperty(globalThis, TEST_OTEL_REGISTRATION);
}
