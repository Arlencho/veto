#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { run } from "./commands.js";
import { errorText } from "./errors.js";
import { productionRuntime } from "./runtime.js";

export async function main(): Promise<void> {
  const runtime = productionRuntime();
  try {
    process.exitCode = await run(process.argv.slice(2), runtime);
  } catch (err) {
    process.stderr.write(`${errorText(err)}\n`);
    process.exitCode = 1;
  } finally {
    runtime.close();
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
