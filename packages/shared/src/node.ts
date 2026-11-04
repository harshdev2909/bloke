import { readFileSync } from "node:fs";
import type { Addresses } from "./index.js";

/** Node-only helpers, kept out of the main entry so browser bundles never pull in node:fs. */
export function loadAddresses(path: string): Addresses {
  return JSON.parse(readFileSync(path, "utf8")) as Addresses;
}
