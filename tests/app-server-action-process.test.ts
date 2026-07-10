import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { build, createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-action-process");
const PROD_SERVER_SOURCE = path.resolve(
  import.meta.dirname,
  "../packages/vinext/src/server/prod-server.ts",
);
const SERVER_HELPER = path.join(FIXTURE_DIR, "start-server.mjs");

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

async function waitForServerPort(child: ChildProcess, getOutput: () => string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = getOutput().match(/VINEXT_TEST_PORT=(\d+)/);
    if (match) return Number(match[1]);
    if (child.exitCode !== null) {
      throw new Error(`Production server exited before startup:\n${getOutput()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for production server:\n${getOutput()}`);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return Promise.race([
    new Promise<true>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

describe("App Router production server action process isolation", () => {
  let child: ChildProcess | undefined;
  let output = "";
  let tempDir: string;
  let baseUrl: string;
  let validActionIds: string[];
  let boundActionMarker: string;
  let boundActionFields: [string, string][];

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(import.meta.dirname, ".tmp-action-process-"));
    const outDir = path.join(FIXTURE_DIR, "dist");
    const builder = await createBuilder({
      root: FIXTURE_DIR,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: FIXTURE_DIR })],
    });
    await builder.buildApp();

    const runtimeDir = path.join(tempDir, "runtime");
    await build({
      root: path.resolve(import.meta.dirname, ".."),
      configFile: false,
      logLevel: "silent",
      build: {
        outDir: runtimeDir,
        ssr: PROD_SERVER_SOURCE,
        rolldownOptions: { output: { entryFileNames: "prod-server.mjs" } },
      },
    });

    child = spawn(
      process.execPath,
      [SERVER_HELPER, path.join(runtimeDir, "prod-server.mjs"), outDir],
      { cwd: path.resolve(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout?.on("data", (chunk) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk) => (output += chunk.toString()));
    const port = await waitForServerPort(child, () => output);
    baseUrl = `http://127.0.0.1:${port}`;

    const initial = await fetch(baseUrl);
    expect(initial.status).toBe(200);
    const html = await initial.text();
    validActionIds = [...html.matchAll(/name="\$ACTION_ID_([^"]+)"/g)].map((match) => match[1]);
    expect(validActionIds).toHaveLength(2);
    const boundMarkerMatch = html.match(/name="(\$ACTION_REF_([^"]+))"/);
    expect(boundMarkerMatch).toBeTruthy();
    boundActionMarker = boundMarkerMatch![1];
    const boundFieldPrefix = `$ACTION_${boundMarkerMatch![2]}:`;
    boundActionFields = [...html.matchAll(/name="(\$ACTION_[^"]+)" value="([^"]*)"/g)]
      .filter((match) => match[1].startsWith(boundFieldPrefix))
      .map((match) => [match[1], decodeHtmlAttribute(match[2])]);
    expect(boundActionFields).toHaveLength(2);
  }, 60_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child, 3_000);
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    await rm(path.join(FIXTURE_DIR, "dist"), { recursive: true, force: true });
    await rm(path.join(FIXTURE_DIR, ".next"), { recursive: true, force: true });
    await rm(path.join(FIXTURE_DIR, "next-env.d.ts"), { force: true });
  });

  // Ported from Next.js: test/e2e/app-dir/actions-unrecognized/actions-unrecognized.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions-unrecognized/actions-unrecognized.test.ts
  // Next.js validates every progressive action reference before decoding:
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/action-handler.ts
  it.each([
    {
      name: "unknown",
      createBody: () => {
        const body = new FormData();
        body.set("$ACTION_ID_a#b", "");
        body.set("$ACTION_ID_c#d", "");
        return body;
      },
    },
    {
      name: "malformed bound",
      createBody: () => {
        const body = new FormData();
        body.set(`$ACTION_ID_${validActionIds[0]}`, "");
        body.set("$ACTION_REF_broken", "");
        body.set("$ACTION_broken:0", "not-json");
        return body;
      },
    },
  ])("returns Next.js' production 500 for $name page action references", async ({ createBody }) => {
    const response = await fetch(baseUrl, {
      method: "POST",
      body: createBody(),
    });
    expect(response.status).toBe(500);
    expect(response.headers.get("x-nextjs-action-not-found")).toBeNull();
    expect(await response.text()).toBe("Internal Server Error");

    expect(await waitForExit(child!, 500)).toBe(false);
    const afterFailure = await fetch(baseUrl);
    expect(afterFailure.status).toBe(200);
  });

  it("passes action-shaped multipart fields through to App Route Handlers", async () => {
    const body = new FormData();
    body.set("$ACTION_ID_first", "first-value");
    body.set("$ACTION_ID_second", "second-value");

    const response = await fetch(`${baseUrl}/action-fields`, {
      method: "POST",
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      ["$ACTION_ID_first", "first-value"],
      ["$ACTION_ID_second", "second-value"],
    ]);
    expect(child!.exitCode).toBeNull();
  });

  // Ported from Next.js: test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/no-server-actions/no-server-actions.test.ts
  it("keeps the action-not-found response for page multipart posts without an action marker", async () => {
    const body = new FormData();
    body.set("ordinary-field", "value");

    const response = await fetch(baseUrl, {
      method: "POST",
      body,
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(await response.text()).toBe("Server action not found.");
    expect(child!.exitCode).toBeNull();
  });

  it("still executes a valid progressive action after a malformed request", async () => {
    const valid = new FormData();
    valid.set(`$ACTION_ID_${validActionIds[0]}`, "");
    const response = await fetch(baseUrl, {
      method: "POST",
      body: valid,
      redirect: "manual",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${baseUrl}/success`);
    expect(child!.exitCode).toBeNull();
  });

  it("preserves the decoder's last-marker behavior for valid action references", async () => {
    const valid = new FormData();
    valid.set(`$ACTION_ID_${validActionIds[0]}`, "");
    valid.set(`$ACTION_ID_${validActionIds[1]}`, "");
    const response = await fetch(baseUrl, {
      method: "POST",
      body: valid,
      redirect: "manual",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${baseUrl}/other-success`);
    expect(child!.exitCode).toBeNull();
  });

  it("preflights bound and unbound references without changing the selected action", async () => {
    const valid = new FormData();
    valid.set(`$ACTION_ID_${validActionIds[0]}`, "");
    valid.set(boundActionMarker, "");
    for (const [key, value] of boundActionFields) valid.set(key, value);
    const response = await fetch(baseUrl, {
      method: "POST",
      body: valid,
      redirect: "manual",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${baseUrl}/bound-success`);
    expect(child!.exitCode).toBeNull();
  });
});
