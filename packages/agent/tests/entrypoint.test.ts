import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

test("the package entry runs an in-memory media loop outside the repository cwd", async () => {
  const cwd = await mkdtemp(`${tmpdir()}/handnote-agent-entry-`);
  try {
    const child = Bun.spawn(
      [process.execPath, `${import.meta.dir}/fixtures/standalone.ts`],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      requests: 3,
      steps: [1, 2, 3],
      markdown: "# Memory note",
      reviewMedia: true,
      result: {
        steps: 3,
        usage: {
          inputTokens: 30,
          outputTokens: 15,
          reasoningTokens: 6,
          textOutputTokens: 9,
        },
      },
      events: [
        "model.run.started",
        "model.step.completed",
        "model.step.completed",
        "model.step.completed",
        "model.run.completed",
      ],
    });
    expect(await readdir(cwd)).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
