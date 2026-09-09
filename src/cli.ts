#!/usr/bin/env bun
import { main } from "@handnote/app";

export { type CliResult, main } from "@handnote/app";

if (import.meta.main) process.exitCode = await main();
