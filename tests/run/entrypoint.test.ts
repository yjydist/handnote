import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

test("CLI and evaluation entries work outside the repository cwd", async () => {
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
      const result = await invoke(
        fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
        args,
      );
      expect(result.exitCode).toBe(args[0] === "--help" ? 0 : 1);
      if (args.includes("--json"))
        expect(JSON.parse(result.stdout)).toMatchObject({
          status: "failed",
          exitCode: 1,
          stopReason: "validation",
        });
    }
    const evaluation = await invoke(
      fileURLToPath(new URL("../../scripts/real-eval.ts", import.meta.url)),
      ["--help"],
    );
    // The existing evaluation CLI classifies Commander's help exit as failure.
    expect(evaluation.exitCode).toBe(1);
    expect(evaluation.stderr).toBe("failed: (outputHelp)\n");
    expect(await readdir(cwd)).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
