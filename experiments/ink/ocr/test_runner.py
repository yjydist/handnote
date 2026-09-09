import json
from pathlib import Path
import tempfile
import unittest

from runner import load_pages


class InputBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "redraw.png").write_bytes(b"test-image-bytes")
        self.page = {
            "page": "2",
            "image": "redraw.png",
            "transform": {"scale": 2, "translateX": 10, "translateY": -20},
        }

    def load(self, pages):
        path = self.root / "input.json"
        path.write_text(json.dumps({"pages": pages}))
        return load_pages(path)

    def test_resolves_manifest_relative_image_and_preserves_transform(self):
        page = self.load([self.page])[0]
        self.assertEqual(page["image"], str((self.root / "redraw.png").resolve()))
        self.assertEqual(page["transform"], self.page["transform"])
        self.assertEqual(len(page["imageHash"]), 64)

    def test_rejects_heldout_page_before_inference(self):
        with self.assertRaisesRegex(ValueError, "restricted"):
            self.load([{**self.page, "page": "3"}])

    def test_rejects_duplicate_page(self):
        with self.assertRaisesRegex(ValueError, "unique"):
            self.load([self.page, self.page])

    def test_rejects_noninvertible_and_nonfinite_transforms(self):
        for value in (0, -1, float("nan"), float("inf"), True):
            with self.subTest(scale=value), self.assertRaises(ValueError):
                self.load([{**self.page, "transform": {**self.page["transform"], "scale": value}}])


if __name__ == "__main__":
    unittest.main()
