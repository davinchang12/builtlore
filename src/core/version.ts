import { readFileSync } from "node:fs";
import { packageRoot } from "./paths.js";
import { join } from "node:path";

export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();
