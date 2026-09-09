"""Project the locked PaddleX word algorithm through the actual OCR crop geometry."""

from functools import lru_cache
from importlib import metadata, util
from numbers import Integral, Real

import cv2
import numpy as np


@lru_cache(maxsize=1)
def _word_box_algorithm():
    # Load this numpy-only module without importing PaddleX's model/runtime package.
    distribution = metadata.distribution("paddlex")
    if distribution.version != "3.3.13":
        raise ValueError("Word mapping requires locked paddlex==3.3.13")
    source = distribution.locate_file(
        "paddlex/inference/pipelines/components/common/cal_ocr_word_box.py"
    )
    spec = util.spec_from_file_location("_locked_paddlex_word_box", source)
    module = util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.cal_ocr_word_box


def _validate_word_info(rec_text, rec_word_info):
    if not isinstance(rec_text, str):
        raise ValueError("rec_text must be a string")
    if not isinstance(rec_word_info, (list, tuple)) or len(rec_word_info) != 4:
        raise ValueError("rec_word_info must contain column count, words, columns and states")
    column_count, words, columns, states = rec_word_info
    # PaddleX scales this count by wh_ratio/max_wh_ratio after CTC decoding.
    if (isinstance(column_count, (bool, np.bool_)) or not isinstance(column_count, Real)
            or not np.isfinite(column_count) or column_count <= 0):
        raise ValueError("CTC column count must be finite and positive")
    if not all(isinstance(value, (list, tuple)) for value in (words, columns, states)):
        raise ValueError("CTC words, columns and states must be sequences")
    if not len(words) == len(columns) == len(states):
        raise ValueError("CTC words, columns and states must have matching lengths")
    previous_column = -1
    characters = []
    for word, word_columns, state in zip(words, columns, states):
        if (not isinstance(word, (list, tuple)) or not word
                or not all(isinstance(char, str) and len(char) == 1 for char in word)):
            raise ValueError("Each CTC word must contain characters")
        if not isinstance(word_columns, (list, tuple)) or len(word_columns) != len(word):
            raise ValueError("Each CTC word must have one column per character")
        if state not in ("cn", "en&num", "symbol"):
            raise ValueError("Unsupported CTC word state")
        for column in word_columns:
            if (isinstance(column, (bool, np.bool_)) or not isinstance(column, Integral)
                    or column <= previous_column):
                raise ValueError("CTC columns must be nonnegative increasing integers")
            if column >= column_count:
                raise ValueError("CTC column lies beyond the valid recognition width")
            previous_column = column
        characters.extend(word)
    if "".join(characters) != rec_text:
        raise ValueError("CTC characters do not match rec_text")


def _project(points, matrix):
    points = np.asarray(points, dtype=np.float64)
    homogeneous = np.column_stack((points.reshape(-1, 2), np.ones(points.size // 2)))
    projected = homogeneous @ matrix.T
    denominator = projected[:, 2]
    if (not np.isfinite(projected).all() or np.any(np.abs(denominator) < 1e-12)
            or not (np.all(denominator > 0) or np.all(denominator < 0))):
        raise ValueError("Word projection crosses the perspective horizon")
    result = (projected[:, :2] / denominator[:, None]).reshape(points.shape)
    if not np.isfinite(result).all():
        raise ValueError("Word projection must be finite")
    return result


def map_rectified_words(crop_quad, crop_shape, rec_text, rec_word_info):
    """Map unchanged CTC words from the recognition crop back to source coordinates.

    ``crop_quad`` must be the ordered float32 quad actually passed to PaddleX's
    ``get_rotate_crop_image``, not the detector polygon. ``crop_shape`` is the
    actual final crop shape after its optional np.rot90, before recognizer resize.
    Invalid/unsupported geometry raises ValueError; no fallback boxes are invented.
    """
    try:
        quad = np.asarray(crop_quad, dtype=np.float32)
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError("crop_quad must contain four finite 2D points") from error
    if quad.shape != (4, 2) or not np.isfinite(quad).all():
        raise ValueError("crop_quad must contain four finite 2D points")
    edges = np.roll(quad.astype(np.float64), -1, axis=0) - quad
    following = np.roll(edges, -1, axis=0)
    cross = edges[:, 0] * following[:, 1] - edges[:, 1] * following[:, 0]
    if not np.all(cross > 0):
        raise ValueError("crop_quad must be nondegenerate, convex and clockwise in image coordinates")
    by_x = sorted(quad.tolist(), key=lambda point: point[0])
    left = sorted(by_x[:2], key=lambda point: point[1])
    right = sorted(by_x[2:], key=lambda point: point[1])
    if quad.tolist() != [left[0], right[0], right[1], left[1]]:
        raise ValueError("crop_quad does not use PaddleX minAreaRect corner order")
    # Preserve float32 norms, max-before-int, and W/H destinations used by PaddleX.
    width = int(max(np.linalg.norm(quad[0] - quad[1]), np.linalg.norm(quad[2] - quad[3])))
    height = int(max(np.linalg.norm(quad[0] - quad[3]), np.linalg.norm(quad[1] - quad[2])))
    if width <= 0 or height <= 0:
        raise ValueError("crop_quad produces degenerate crop dimensions")
    rotated = height / width >= 1.5
    crop_width, crop_height = (height, width) if rotated else (width, height)
    if (not isinstance(crop_shape, (list, tuple)) or len(crop_shape) != 3
            or any(isinstance(value, (bool, np.bool_)) or not isinstance(value, Integral)
                   or value <= 0 for value in crop_shape)
            or list(crop_shape[:2]) != [crop_height, crop_width]):
        raise ValueError("Actual crop_shape disagrees with PaddleX crop dimensions/rotation")
    _validate_word_info(rec_text, rec_word_info)

    destination = np.float32([[0, 0], [width, 0], [width, height], [0, height]])
    source_to_pre_rotation = cv2.getPerspectiveTransform(quad, destination)
    # Preserve Paddle's nominal [0,W] box extents. This is not the strict pixel-edge
    # transform T(+.5) @ R_center @ H @ T(-.5); actual sampling centers are separate.
    edge_rotation = np.eye(3, dtype=np.float64)
    pixel_rotation = np.eye(3, dtype=np.float64)
    if rotated:
        edge_rotation = np.array([[0, 1, 0], [-1, 0, width], [0, 0, 1]], dtype=np.float64)
        pixel_rotation = np.array([[0, 1, 0], [-1, 0, width - 1], [0, 0, 1]], dtype=np.float64)
    source_to_recognition = edge_rotation @ source_to_pre_rotation
    source_to_pixel_centers = pixel_rotation @ source_to_pre_rotation
    try:
        recognition_to_source = np.linalg.inv(source_to_recognition)
        pixel_centers_to_source = np.linalg.inv(source_to_pixel_centers)
    except np.linalg.LinAlgError as error:
        raise ValueError("crop_quad has a singular perspective transform") from error
    matrices = [source_to_pre_rotation, source_to_recognition, recognition_to_source,
                source_to_pixel_centers, pixel_centers_to_source]
    if not all(np.isfinite(matrix).all() for matrix in matrices):
        raise ValueError("Crop perspective transforms must be finite")

    rectangle = np.array([[0, 0], [crop_width, 0], [crop_width, crop_height], [0, crop_height]])
    words, raw_polygons = _word_box_algorithm()(rec_text, rectangle, rec_word_info)
    if len(words) != len(raw_polygons):
        raise ValueError("Locked word algorithm returned mismatched words and polygons")
    polygons = np.asarray(raw_polygons, dtype=np.float64).reshape(-1, 4, 2)
    if len(polygons) and (not np.isfinite(polygons).all()
                         or np.any(polygons[:, 1, 0] <= polygons[:, 0, 0])
                         or np.any(polygons[:, 2, 1] <= polygons[:, 0, 1])):
        raise ValueError("Locked word algorithm returned degenerate word geometry")
    projected = _project(polygons, recognition_to_source) if len(polygons) else polygons.copy()
    boxes = [[float(polygon[:, 0].min()), float(polygon[:, 1].min()),
              float(polygon[:, 0].max()), float(polygon[:, 1].max())] for polygon in projected]
    return {
        "cropQuad": quad.tolist(),
        "cropShape": [int(value) for value in crop_shape],
        "preRotationDimensions": {"width": width, "height": height},
        "recognitionDimensions": {"width": crop_width, "height": crop_height},
        "rotation": "ccw90" if rotated else "none",
        "coordinateConvention": "Paddle nominal box extents [0,W]x[0,H], not strict pixel edges; sourceToRecognition=R_nominal@H, ccw90=(y,W-x); pixel-center sampling=R_center@H, ccw90=(y,W-1-x)",
        "sourceToPreRotation": source_to_pre_rotation.tolist(),
        "sourceToRecognition": source_to_recognition.tolist(),
        "recognitionToSource": recognition_to_source.tolist(),
        "sourceToRecognitionPixelCenters": source_to_pixel_centers.tolist(),
        "recognitionPixelCentersToSource": pixel_centers_to_source.tolist(),
        "rectifiedWords": list(words),
        "rectifiedWordPolygons": polygons.tolist(),
        "projectedWordPolygons": projected.tolist(),
        "projectedWordBoxes": boxes,
    }
