import fs from "node:fs";
import path from "node:path";
import { readPrerenderManifest } from "../server/prerender-manifest.js";
import {
  stripPregeneratedConcretePathsInjection,
  VINEXT_PREGENERATED_CONCRETE_PATHS_END,
  VINEXT_PREGENERATED_CONCRETE_PATHS_START,
} from "../server/pregenerated-concrete-paths-injection.js";

export function injectPregeneratedConcretePaths(root: string): void {
  const workerEntry = path.resolve(root, "dist", "server", "index.js");
  if (!fs.existsSync(workerEntry)) return;

  let code = stripPregeneratedConcretePathsInjection(fs.readFileSync(workerEntry, "utf-8"));
  const manifest = readPrerenderManifest(
    path.join(root, "dist", "server", "vinext-prerender.json"),
  );
  const table = manifest?.pregeneratedConcretePaths ?? [];

  if (table.length > 0) {
    code =
      `${VINEXT_PREGENERATED_CONCRETE_PATHS_START}\n` +
      `globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = ${JSON.stringify(table)};\n` +
      `${VINEXT_PREGENERATED_CONCRETE_PATHS_END}\n` +
      code;
  }

  fs.writeFileSync(workerEntry, code);
}
