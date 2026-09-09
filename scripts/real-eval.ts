#!/usr/bin/env bun
import { main } from "@handnote/app/evaluation";

export * from "@handnote/app/evaluation";

if (import.meta.main) process.exitCode = await main();
