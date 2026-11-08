import assert from "node:assert/strict";
import test from "node:test";
import { runServer } from "./run.js";

test("runServer resolves with a failure code when the command isn't installed", async () => {
  const code = await runServer(
    process.cwd(),
    { cmd: "breakinggood-no-such-command", args: [], label: "breakinggood-no-such-command" },
    { open: false, knownPorts: [] },
  );
  assert.equal(code, 1);
});
