import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

test("root compatibility entries preserve application output outside the repository cwd", async () => {
  const cwd = await mkdtemp(`${tmpdir()}/handnote-app-entry-`);
  const invoke = async (entry: string, args: string[]) => {
    const child = Bun.spawn([process.execPath, entry, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };
  try {
    for (const args of [["--help"], ["run", "--json"]]) {
      const [legacy, application] = await Promise.all([
        invoke(
          fileURLToPath(new URL("../../../src/cli.ts", import.meta.url)),
          args,
        ),
        invoke(Bun.resolveSync("@handnote/app", import.meta.dir), args),
      ]);
      expect(legacy).toEqual(application);
      expect(legacy.exitCode).toBe(args[0] === "--help" ? 0 : 1);
      if (args.includes("--json"))
        expect(JSON.parse(legacy.stdout)).toMatchObject({
          status: "failed",
          exitCode: 1,
          stopReason: "validation",
        });
    }
    const [legacyEvaluation, applicationEvaluation] = await Promise.all([
      invoke(
        fileURLToPath(
          new URL("../../../scripts/real-eval.ts", import.meta.url),
        ),
        ["--help"],
      ),
      invoke(Bun.resolveSync("@handnote/app/evaluation", import.meta.dir), [
        "--help",
      ]),
    ]);
    expect(legacyEvaluation).toEqual(applicationEvaluation);
    // The existing evaluation CLI classifies Commander's help exit as failure.
    expect(legacyEvaluation.exitCode).toBe(1);
    expect(legacyEvaluation.stderr).toBe("failed: (outputHelp)\n");
    expect(await readdir(cwd)).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
