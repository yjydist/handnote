import { expect, test } from "bun:test";
import {
  compileNoteMarkdown,
  ImageResourceError,
} from "../src/markdown-compiler.ts";

test("compiles media supplied by a caller without a run directory", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const note = await compileNoteMarkdown(
    "![图](virtual/one.webp)\n\n![同图](virtual/one.webp)",
    {
      resolveImage: async (src) => {
        expect(src).toBe("virtual/one.webp");
        return { bytes, mimeType: "image/webp" };
      },
    },
  );
  expect(note.html.match(/data:image\/webp;base64,AQID/g)).toHaveLength(2);
  expect(note).not.toHaveProperty("assets");
});

test("attaches source lines to resource failures without masking resolver errors", async () => {
  await expect(
    compileNoteMarkdown("# 标题\n\n![图](missing)", {
      resolveImage: async () => {
        throw new ImageResourceError("missing_figure", "Missing");
      },
    }),
  ).rejects.toMatchObject({
    issues: [{ code: "missing_figure", message: "Missing", line: 3 }],
  });
  const failure = new Error("storage unavailable");
  await expect(
    compileNoteMarkdown("![图](asset)", {
      resolveImage: async () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
});

test("text-only compilation needs no resolver and images fail explicitly without one", async () => {
  expect((await compileNoteMarkdown("正文")).html).toContain("正文");
  await expect(compileNoteMarkdown("![图](asset)")).rejects.toMatchObject({
    issues: [expect.objectContaining({ code: "invalid_image_path" })],
  });
});
