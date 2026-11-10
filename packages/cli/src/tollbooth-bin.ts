#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Deprecated `tollbooth` bin: the CLI was renamed fareseal on 2026-11-10. Says
// so once on stderr (stdout stays clean for scripts), then runs the same main,
// so stdout and the exit code are exactly fareseal's. Removed in 3.0.0.
process.stderr.write(
  "tollbooth: renamed fareseal on 2026-11-10; use `fareseal` (this alias is removed in 3.0.0)\n",
);
await import("./cli.js");
