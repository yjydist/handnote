import ast
from importlib import metadata
import json
import unittest

import cv2
import numpy as np

from rectified_word_mapping import map_rectified_words, _word_box_algorithm


def project(points, matrix):
    points = np.asarray(points, dtype=np.float64)
    shape = points.shape
    points = points.reshape(-1, 2)
    homogeneous = np.column_stack((points, np.ones(len(points)))) @ np.asarray(matrix).T
    return (homogeneous[:, :2] / homogeneous[:, 2:]).reshape(shape)


class RectifiedWordMappingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Execute the installed crop method itself, without importing or loading models.
        source = metadata.distribution("paddlex").locate_file(
            "paddlex/inference/pipelines/components/common/crop_image_regions.py"
        )
        tree = ast.parse(source.read_text())
        crop_class = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                          and node.name == "CropByPolys")
        method = next(node for node in crop_class.body if isinstance(node, ast.FunctionDef)
                      and node.name == "get_rotate_crop_image")
        namespace = {"cv2": cv2, "np": np}
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(source), "exec"), namespace)
        cls.locked_crop = staticmethod(namespace["get_rotate_crop_image"])

    def map(self, quad=None, text="测试abc", info=None, shape=None):
        quad = np.float32(quad if quad is not None else [[10, 20], [110, 20], [110, 40], [10, 40]])
        info = info if info is not None else [20.5, [["测", "试"], ["a", "b", "c"]],
                                                [[2, 5], [10, 12, 14]], ["cn", "en&num"]]
        if shape is None:
            shape = self.locked_crop(None, np.zeros((240, 320, 3), dtype=np.uint8), quad).shape
        return map_rectified_words(quad, shape, text, info)

    def test_axis_aligned_uses_locked_algorithm_and_preserves_text_order(self):
        result = self.map()
        expected_words, expected_polygons = _word_box_algorithm()(
            "测试abc", np.array([[0, 0], [100, 0], [100, 20], [0, 20]]),
            [20.5, [["测", "试"], ["a", "b", "c"]], [[2, 5], [10, 12, 14]], ["cn", "en&num"]],
        )
        self.assertEqual(result["rectifiedWords"], expected_words)
        np.testing.assert_equal(result["rectifiedWordPolygons"], expected_polygons)
        np.testing.assert_allclose(result["projectedWordPolygons"], np.array(expected_polygons) + [10, 20])
        self.assertEqual(result["rotation"], "none")
        json.dumps(result, allow_nan=False)

    def test_slanted_and_perspective_quads_match_locked_crop_dimensions(self):
        for quad in ([[[20, 10], [120, 30], [116, 50], [16, 30]],
                      [[20, 15], [120, 25], [130, 60], [10, 50]]]):
            with self.subTest(quad=quad):
                result = self.map(quad)
                width, height = result["preRotationDimensions"].values()
                expected_corners = [[0, 0], [width, 0], [width, height], [0, height]]
                np.testing.assert_allclose(project(quad, result["sourceToPreRotation"]), expected_corners,
                                           atol=1e-10)
                np.testing.assert_allclose(
                    project(result["projectedWordPolygons"], result["sourceToRecognition"]),
                    result["rectifiedWordPolygons"], atol=1e-10,
                )
                for polygon, box in zip(result["projectedWordPolygons"], result["projectedWordBoxes"]):
                    polygon = np.array(polygon)
                    np.testing.assert_equal(box, [*polygon.min(axis=0), *polygon.max(axis=0)])

    def test_ccw90_separates_nominal_box_extent_from_actual_pixel_centers(self):
        quad = [[10, 20], [30, 20], [30, 100], [10, 100]]
        result = self.map(quad)
        self.assertEqual(result["rotation"], "ccw90")
        self.assertEqual(result["preRotationDimensions"], {"width": 20, "height": 80})
        self.assertEqual(result["recognitionDimensions"], {"width": 80, "height": 20})
        self.assertIn("not strict pixel edges", result["coordinateConvention"])
        np.testing.assert_allclose(project(quad, result["sourceToRecognition"]),
                                   [[0, 20], [0, 0], [80, 0], [80, 20]], atol=1e-10)
        np.testing.assert_allclose(project(quad, result["sourceToRecognitionPixelCenters"]),
                                   [[0, 19], [0, -1], [80, -1], [80, 19]], atol=1e-10)
        source = np.arange(140 * 60, dtype=np.float32).reshape(140, 60)
        crop = self.locked_crop(None, source, np.float32(quad))
        for x, y in ((10, 20), (29, 99), (18, 60)):
            crop_x, crop_y = np.rint(project([[x, y]], result["sourceToRecognitionPixelCenters"])[0]).astype(int)
            self.assertEqual(crop[crop_y, crop_x], source[y, x])
        for forward, inverse in (("sourceToRecognition", "recognitionToSource"),
                                 ("sourceToRecognitionPixelCenters", "recognitionPixelCentersToSource")):
            np.testing.assert_allclose(np.asarray(result[forward]) @ result[inverse], np.eye(3), atol=1e-10)

    def test_rotation_threshold_uses_integer_dimensions(self):
        for height, rotation in ((29.9, "none"), (30, "ccw90")):
            result = self.map([[0, 0], [20, 0], [20, height], [0, height]])
            self.assertEqual(result["rotation"], rotation)

    def test_scale_translation_roundtrip_to_original_source(self):
        quad = np.array([[20, 10], [120, 30], [116, 50], [16, 30]], dtype=float)
        scale, translation = 2, np.array([30, -7])
        result = self.map(quad * scale + translation)
        original_word_polygons = (np.array(result["projectedWordPolygons"]) - translation) / scale
        reconstructed_input = original_word_polygons * scale + translation
        np.testing.assert_allclose(project(reconstructed_input, result["sourceToRecognition"]),
                                   result["rectifiedWordPolygons"], atol=1e-10)

    def test_rejects_shape_mismatch_and_invalid_shapes(self):
        for shape in ([100, 20, 3], [20, 99, 3], [20, 100], [20, 100, 0], [20, 100, True]):
            with self.subTest(shape=shape), self.assertRaisesRegex(ValueError, "crop_shape"):
                self.map(shape=shape)

    def test_rejects_invalid_quads(self):
        invalid = [
            [[float("nan"), 0], [100, 0], [100, 20], [0, 20]],
            [[0, 0], [float("inf"), 0], [100, 20], [0, 20]],
            [[0, 0], [100, 0], [100, 0], [0, 0]],
            [[0, 0], [100, 20], [100, 0], [0, 20]],
            [[0, 0], [0, 20], [100, 20], [100, 0]],
            [[100, 0], [100, 20], [0, 20], [0, 0]],
            [[0, 0], [100, 0], [20, 10], [0, 20]],
            [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]],
        ]
        for quad in invalid:
            with self.subTest(quad=quad), self.assertRaises(ValueError):
                self.map(quad, shape=[20, 100, 3])

    def test_scaled_ctc_column_count_is_float(self):
        result = self.map(text="a", info=[19.25, [["a"]], [[5]], ["en&num"]])
        self.assertEqual(result["rectifiedWords"], ["a"])

    def test_single_character_zero_width_from_locked_algorithm_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "degenerate word"):
            self.map(text="a", info=[1000.5, [["a"]], [[0]], ["en&num"]])

    def test_rejects_inconsistent_ctc_inputs(self):
        for info in ([0, [["a"]], [[1]], ["en&num"]],
                     [float("nan"), [["a"]], [[1]], ["en&num"]],
                     [10, [["a"]], [[1.5]], ["en&num"]],
                     [10, [["a"]], [[-1]], ["en&num"]],
                     [10, [["a"]], [[True]], ["en&num"]],
                     [10.5, [["a"]], [[11]], ["en&num"]],
                     [10, [["a"]], [[10]], ["en&num"]],
                     [10, [["a"]], [[1]], ["unknown"]],
                     [10, [["a"]], [], ["en&num"]],
                     [10, [["b"]], [[1]], ["en&num"]]):
            with self.subTest(info=info), self.assertRaises(ValueError):
                self.map(text="a", info=info)

    def test_empty_recognition_preserves_empty_words(self):
        result = self.map(text="", info=[10.5, [], [], []])
        for key in ("rectifiedWords", "rectifiedWordPolygons", "projectedWordPolygons", "projectedWordBoxes"):
            self.assertEqual(result[key], [])


if __name__ == "__main__":
    unittest.main()
