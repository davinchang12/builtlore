import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory containing builtlore's own package.json (works from src or dist). */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "assets"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Could not locate builtlore package root");
}
