import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace

from runner import input_id, load_pages, predict_with_dimensions


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

    def variant(self, name="page-2x", line_id=0):
        page = {
            **self.page,
            "variant": name,
            "inputId": "page-2-2x",
            "sourceHash": "a" * 64,
            "baselineOcrHash": "b" * 64,
            "imageHash": hashlib.sha256(b"test-image-bytes").hexdigest(),
            "baselineOcrFile": "/baseline/page-2.raw.json",
        }
        if name == "line-2x":
            page.update(inputId=f"page-2-line-{line_id}-2x", baselineLineId=line_id,
                        crop={"left": 0, "top": 20, "width": 200, "height": 40})
        return page

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

    def test_keeps_legacy_output_identity(self):
        self.assertEqual(input_id(self.load([self.page])[0]), "page-2")

    def test_distinct_variants_of_same_page_preserve_metadata(self):
        originals = [self.page, self.variant(), self.variant("line-2x"), self.variant("line-2x", 1)]
        pages = self.load(originals)
        self.assertEqual([input_id(page) for page in pages],
                         ["page-2", "page-2-2x", "page-2-line-0-2x", "page-2-line-1-2x"])
        for original, page in zip(originals, pages):
            for key, value in original.items():
                if key != "image":
                    self.assertEqual(page[key], value)

    def test_duplicate_variant_identity_is_rejected(self):
        for page in (self.variant(), self.variant("line-2x")):
            with self.subTest(variant=page["variant"]), self.assertRaisesRegex(ValueError, "unique"):
                self.load([page, page])

    def test_variant_cannot_access_heldout_page(self):
        with self.assertRaisesRegex(ValueError, "restricted"):
            self.load([{**self.variant(), "page": "3", "inputId": "page-3-2x"}])

    def test_variant_identity_must_match_page_and_line(self):
        for identity in ("page-69-2x", "page-2", "../page-2-2x", "page-2-line-1-2x", None):
            with self.subTest(identity=identity), self.assertRaisesRegex(ValueError, "inputId"):
                self.load([{**self.variant(), "inputId": identity}])
        with self.assertRaisesRegex(ValueError, "inputId"):
            self.load([{**self.variant("line-2x"), "inputId": "page-2-line-1-2x"}])

    def test_requires_known_variant_and_disallows_legacy_metadata_bypass(self):
        for variant in ("baseline", "page-3x", None, [], {}):
            with self.subTest(variant=variant), self.assertRaises(ValueError):
                self.load([{**self.variant(), "variant": variant}])
        for key in ("inputId", "crop", "baselineLineId"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.load([{**self.page, key: self.variant("line-2x")[key]}])

    def test_whole_page_rejects_line_metadata_even_if_null(self):
        for key in ("crop", "baselineLineId"):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "Whole-page"):
                self.load([{**self.variant(), key: None}])

    def test_line_id_is_nonnegative_integer(self):
        for line_id in (-1, 0.5, True, None, "0"):
            with self.subTest(line_id=line_id), self.assertRaisesRegex(ValueError, "baselineLineId"):
                self.load([{**self.variant("line-2x"), "baselineLineId": line_id}])

    def test_crop_is_complete_integer_rectangle(self):
        page = self.variant("line-2x")
        for crop in (None, {}, {**page["crop"], "extra": 1}):
            with self.subTest(crop=crop), self.assertRaisesRegex(ValueError, "crop"):
                self.load([{**page, "crop": crop}])
        for key in ("left", "top", "width", "height"):
            for value in (-1, 0.5, True, None):
                with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, "crop"):
                    self.load([{**page, "crop": {**page["crop"], key: value}}])
        for key in ("width", "height"):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "crop"):
                self.load([{**page, "crop": {**page["crop"], key: 0}}])

    def test_variant_requires_sha256_metadata(self):
        for key in ("sourceHash", "baselineOcrHash", "imageHash"):
            for value in (None, "", "z" * 64, "a" * 63, True):
                with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, key):
                    self.load([{**self.variant(), key: value}])

    def test_image_hash_validates_actual_bytes(self):
        with self.assertRaisesRegex(ValueError, "imageHash differs"):
            self.load([{**self.variant(), "imageHash": "0" * 64}])


class FakeInference:
    def __call__(self, *, x):
        return x


class FakeDetector:
    def __init__(self):
        self.infer = FakeInference()
        self.pre_tfs = {"Resize": FakeInference()}


class FakePipeline:
    def __init__(self, fail=False):
        self.detector = FakeDetector()
        self.paddlex_pipeline = SimpleNamespace(
            text_det_model=self.detector,
            get_text_det_params=lambda: {"limit_side_len": 736, "limit_type": "min", "max_side_limit": 4000},
        )
        self.fail = fail

    def predict(self, image_path):
        self.detector.infer(x=[SimpleNamespace(shape=(1, 3, 96, 4000))])
        if self.fail:
            raise RuntimeError("inference failed")
        yield {"result": "kept"}


class DimensionCaptureTests(unittest.TestCase):
    def setUp(self):
        from PIL import Image

        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.image = Path(self.directory.name) / "input.png"
        Image.new("RGB", (2500, 60)).save(self.image)

    def test_records_observed_tensor_independently_of_input_dimensions(self):
        pipeline = FakePipeline()
        original = pipeline.detector.infer
        results, dimensions, preprocessing = predict_with_dimensions(pipeline, str(self.image))
        self.assertEqual(results, [{"result": "kept"}])
        self.assertEqual(dimensions, {"width": 2500, "height": 60})
        self.assertEqual(preprocessing["tensorShape"], [1, 3, 96, 4000])
        self.assertEqual(preprocessing["method"], "captured-inference-input")
        self.assertEqual(preprocessing["width"], 4000)
        self.assertEqual(preprocessing["height"], 96)
        self.assertEqual(preprocessing["parameters"]["max_side_limit"], 4000)
        self.assertEqual(len(preprocessing["provenance"]["predictor"]["sha256"]), 64)
        self.assertIs(pipeline.detector.infer, original)

    def test_restores_inference_on_failure_and_propagates_error(self):
        pipeline = FakePipeline(fail=True)
        original = pipeline.detector.infer
        with self.assertRaisesRegex(RuntimeError, "inference failed"):
            predict_with_dimensions(pipeline, str(self.image))
        self.assertIs(pipeline.detector.infer, original)


if __name__ == "__main__":
    unittest.main()
