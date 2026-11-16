import type { Adapter } from "../core/types.js";
import { laravelAdapter } from "./laravel/index.js";

/**
 * Registered adapters, in detection order.
 * Planned next: Go (net/http, gin, echo, chi), Next.js, Flutter.
 */
export const adapters: Adapter[] = [laravelAdapter];
