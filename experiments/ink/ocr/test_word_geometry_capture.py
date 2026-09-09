"""Offline capture contract tests; no OCR model is imported or loaded."""

import copy
import hashlib
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from word_geometry_capture import capture_word_geometry


WORD_CALLS = []
WORD_RESULTS = []


def cal_ocr_word_box(rec_str, box, rec_word_info):
    WORD_CALLS.append((rec_str, box, rec_word_info))
    return WORD_RESULTS[len(WORD_CALLS) - 1]


class FakeCropper:
    det_box_type = "quad"

    def __init__(self):
        self.calls = []
        self.outputs = [np.arange(18, dtype=np.uint8).reshape(2, 3, 3),
                        np.full((2, 6, 3), 127, dtype=np.uint8)]

    def get_rotate_crop_image(self, img, points):
        self.calls.append((img, points))
        return self.outputs[len(self.calls) - 1]


class FakeOCR:
    use_doc_preprocessor = False
    use_textline_orientation = False

    def __init__(self):
        self._crop_by_polys = FakeCropper()
        self.text_rec_model = FakeRecognizer()


class FakeResize:
    rec_image_shape = [3, 48, 320]
    input_shape = None
    max_imgW = 3200


class FakeRecognizer:
    def __init__(self):
        self.pre_tfs = {"ReisizeNorm": FakeResize()}
        self.batch_sampler = SimpleNamespace(batch_size=1)
        self.post_op = FakeDecoder()
        self.calls = []
        self.result = object()

    def infer(self, *, x):
        self.calls.append(x)
        return self.result


class FakeDecoder:
    pass


class CaptureTests(unittest.TestCase):
    def setUp(self):
        WORD_CALLS.clear()
        WORD_RESULTS[:] = [(["甲"], [((0, 0), (3, 0), (3, 2), (0, 2))]),
                          (["乙"], [((5, 0), (7, 0), (7, 6), (5, 6))])]
        self.addCleanup(WORD_CALLS.clear)
        self.addCleanup(WORD_RESULTS.clear)
        self.version = patch("word_geometry_capture.importlib.metadata.version", return_value="3.3.13")
        self.version.start()
        self.addCleanup(self.version.stop)
        self.pipeline = SimpleNamespace(paddlex_pipeline=FakeOCR())
        self.cropper = self.pipeline.paddlex_pipeline._crop_by_polys
        self.recognizer = self.pipeline.paddlex_pipeline.text_rec_model
        self.img = np.zeros((20, 20, 3), dtype=np.uint8)
        self.points = [np.array([[0, 0], [3, 0], [3, 2], [0, 2]], dtype=np.float32),
                       np.array([[5, 0], [7, 0], [7, 6], [5, 6]], dtype=np.float32)]
        self.infos = [(np.float64(9), [["甲"]], [[np.int64(3)]], ["cn"]),
                      (np.float64(18), [["乙"]], [[np.int64(8)]], ["cn"])]
        self.raw = {"rec_texts": ["甲", "乙"], "rec_polys": [p.tolist() for p in self.points],
                    "text_word_boxes": [[[0, 0, 3, 2]], [[5, 0, 7, 6]]],
                    "textline_orientation_angles": [-1, -1],
                    "model_settings": {"use_doc_preprocessor": False, "use_textline_orientation": False}}

    def infer(self):
        for index, points in enumerate(self.points):
            self.assertIs(self.cropper.get_rotate_crop_image(self.img, points), self.cropper.outputs[index])
        for output in sorted(self.cropper.outputs, key=lambda crop: crop.shape[1] / crop.shape[0]):
            width = min(3200, int(48 * max(320 / 48, output.shape[1] / output.shape[0])))
            tensors = [SimpleNamespace(shape=(1, 3, 48, width))]
            self.assertIs(self.recognizer.infer(x=tensors), self.recognizer.result)
            self.assertIs(self.recognizer.calls[-1], tensors)
        for index, text in enumerate(self.raw["rec_texts"]):
            self.assertIs(cal_ocr_word_box(text, self.points[index], self.infos[index]), WORD_RESULTS[index])

    def test_captures_actual_pixels_ctc_values_and_line_order_without_changing_inputs(self):
        originals = [p.copy() for p in self.points]
        info_originals = copy.deepcopy(self.infos)
        original_words = cal_ocr_word_box
        original_crop = self.cropper.get_rotate_crop_image
        original_infer = self.recognizer.infer
        with capture_word_geometry(self.pipeline) as capture:
            self.infer()
        evidence = capture.serialize({"res": self.raw})
        json.dumps(evidence, allow_nan=False)
        self.assertIs(cal_ocr_word_box, original_words)
        self.assertEqual(self.cropper.get_rotate_crop_image, original_crop)
        self.assertEqual(self.recognizer.infer, original_infer)
        self.assertNotIn("infer", vars(self.recognizer))
        self.assertNotIn("get_rotate_crop_image", vars(self.cropper))
        self.assertEqual([line["recognition"]["text"] for line in evidence["lines"]], ["甲", "乙"])
        for index, line in enumerate(evidence["lines"]):
            self.assertEqual(line["lineIndex"], index)
            self.assertEqual(line["crop"]["orderedPoints"], originals[index].tolist())
            self.assertEqual(line["crop"]["outputShape"], list(self.cropper.outputs[index].shape))
            self.assertEqual(line["crop"]["pixelSha256"], hashlib.sha256(self.cropper.outputs[index].tobytes()).hexdigest())
            self.assertIs(self.cropper.calls[index][0], self.img)
            self.assertIs(self.cropper.calls[index][1], self.points[index])
            self.assertIs(WORD_CALLS[index][1], self.points[index])
            self.assertIs(WORD_CALLS[index][2], self.infos[index])
            np.testing.assert_array_equal(self.points[index], originals[index])
        self.assertEqual(self.infos, info_originals)
        self.assertEqual(evidence["lines"][0]["recognition"]["recWordInfo"], [9.0, [["甲"]], [[3]], ["cn"]])
        self.assertEqual(evidence["lines"][1]["crop"]["rotationQuarterTurnsCCW"], 1)
        self.assertEqual(evidence["lines"][1]["crop"]["preRotationShape"], [6, 2])
        self.assertEqual(evidence["provenance"]["paddlexVersion"], "3.3.13")
        self.assertEqual(len(evidence["provenance"]["wordBox"]["sha256"]), 64)
        self.assertEqual(evidence["recognitionPreprocessing"]["recImageShape"], [3, 48, 320])
        self.assertEqual(evidence["lines"][0]["recognition"]["tensorShape"], [1, 3, 48, 320])

    def test_restores_both_hooks_on_inference_failure(self):
        original_words = cal_ocr_word_box
        original_crop = self.cropper.get_rotate_crop_image
        original_infer = self.recognizer.infer
        with self.assertRaisesRegex(RuntimeError, "inference failed"):
            with capture_word_geometry(self.pipeline):
                self.cropper.get_rotate_crop_image(self.img, self.points[0])
                raise RuntimeError("inference failed")
        self.assertIs(cal_ocr_word_box, original_words)
        self.assertEqual(self.cropper.get_rotate_crop_image, original_crop)
        self.assertEqual(self.recognizer.infer, original_infer)

    def test_restores_existing_instance_hook_on_wrapped_function_failure(self):
        def failing_crop(img, points):
            raise RuntimeError("crop failed")
        self.cropper.get_rotate_crop_image = failing_crop
        original_words = cal_ocr_word_box
        with self.assertRaisesRegex(RuntimeError, "crop failed"):
            with capture_word_geometry(self.pipeline):
                self.cropper.get_rotate_crop_image(self.img, self.points[0])
        self.assertIs(self.cropper.get_rotate_crop_image, failing_crop)
        self.assertIs(cal_ocr_word_box, original_words)

    def test_rejects_raw_count_order_or_word_geometry_mismatch(self):
        with capture_word_geometry(self.pipeline) as capture:
            self.infer()
        changes = [{"rec_texts": ["甲"]}, {"rec_texts": ["乙", "甲"]},
                   {"rec_polys": list(reversed(self.raw["rec_polys"]))},
                   {"text_word_boxes": [[[0, 0, 2, 2]], [[5, 0, 7, 6]]]},
                   {"textline_orientation_angles": [0, -1]},
                   {"model_settings": {"use_doc_preprocessor": True}}]
        for changed in changes:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                capture.serialize({**self.raw, **changed})

    def test_rejects_unsupported_crop_and_orientation_paths_before_installing_hooks(self):
        for owner, key, value in [(self.cropper, "det_box_type", "poly"),
                                  (self.pipeline.paddlex_pipeline, "use_doc_preprocessor", True),
                                  (self.pipeline.paddlex_pipeline, "use_textline_orientation", True)]:
            with self.subTest(key=key), patch.object(owner, key, value), self.assertRaises(ValueError):
                with capture_word_geometry(self.pipeline):
                    self.fail("Unsupported pipeline was accepted")

    def test_rejects_nested_capture_without_losing_outer_hooks(self):
        with capture_word_geometry(self.pipeline):
            outer_hook = cal_ocr_word_box
            with self.assertRaisesRegex(RuntimeError, "Overlapping"):
                with capture_word_geometry(self.pipeline):
                    self.fail("Nested capture was accepted")
            self.assertIs(cal_ocr_word_box, outer_hook)

    def test_assigns_ratio_sorted_inference_tensors_back_to_original_line_order(self):
        self.cropper.outputs[0] = np.zeros((2, 20, 3), dtype=np.uint8)
        with capture_word_geometry(self.pipeline) as capture:
            self.infer()
        evidence = capture.serialize(self.raw)
        self.assertEqual([line["recognition"]["tensorShape"][-1] for line in evidence["lines"]], [480, 320])

    def test_rejects_clipped_recognition_width_and_unexpected_tensor_shape(self):
        self.cropper.outputs[0] = np.zeros((2, 140, 3), dtype=np.uint8)
        with capture_word_geometry(self.pipeline) as capture:
            self.infer()
        with self.assertRaisesRegex(ValueError, "width clipping"):
            capture.serialize(self.raw)
        capture.crops[0]["outputShape"] = [2, 3, 3]
        with self.assertRaisesRegex(ValueError, "tensor shape differs"):
            capture.serialize(self.raw)

    def test_rejects_static_resize_or_multiple_recognition_batch(self):
        for owner, key, value in [(self.recognizer.pre_tfs["ReisizeNorm"], "input_shape", [3, 48, 320]),
                                  (self.recognizer.batch_sampler, "batch_size", 2)]:
            with self.subTest(key=key), patch.object(owner, key, value), self.assertRaises(ValueError):
                with capture_word_geometry(self.pipeline):
                    self.fail("Unsupported recognition preprocessing was accepted")

    def test_restores_infer_and_other_hooks_when_recognizer_raises(self):
        def failing_infer(*, x):
            raise RuntimeError("recognition failed")
        self.recognizer.infer = failing_infer
        original_words = cal_ocr_word_box
        original_crop = self.cropper.get_rotate_crop_image
        with self.assertRaisesRegex(RuntimeError, "recognition failed"):
            with capture_word_geometry(self.pipeline):
                self.recognizer.infer(x=[SimpleNamespace(shape=(1, 3, 48, 320))])
        self.assertIs(self.recognizer.infer, failing_infer)
        self.assertEqual(self.cropper.get_rotate_crop_image, original_crop)
        self.assertIs(cal_ocr_word_box, original_words)

    def test_rejects_observed_non_singleton_inference_batch(self):
        original_infer = self.recognizer.infer
        with self.assertRaisesRegex(ValueError, "batch size 1"):
            with capture_word_geometry(self.pipeline):
                self.recognizer.infer(x=[SimpleNamespace(shape=(2, 3, 48, 320))])
        self.assertEqual(self.recognizer.infer, original_infer)


if __name__ == "__main__":
    unittest.main()
