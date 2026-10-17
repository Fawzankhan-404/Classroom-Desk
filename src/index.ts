#!/usr/bin/env node
import { runServer } from "./server.js";

runServer().catch((error: unknown) => {
  // Never serialize OAuth credentials or Google response bodies to stderr.
  const message = error instanceof Error ? error.message : "Server failed to start";
  process.stderr.write(`GPT-GoogleClassroom: ${message}\n`);
  process.exitCode = 1;
});
