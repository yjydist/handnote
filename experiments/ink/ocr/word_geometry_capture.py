"""Observe the locked PaddleX quad crop and CTC word-box inputs for one page.

The pipeline-level word-box function is temporarily patched, so capture contexts
must not overlap or share concurrent inference in this process.
"""

from contextlib import contextmanager
import hashlib
import importlib.metadata
import inspect
from pathlib import Path

import numpy as np


def _json_value(value):
    if isinstance(value, np.ndarray):
        return _json_value(value.tolist())
    if isinstance(value, np.generic):
        return _json_value(value.item())
    if isinstance(value, (tuple, list)):
        return [_json_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    raise TypeError(f"Unsupported capture value: {type(value).__name__}")


def _source(obj):
    path = Path(inspect.getfile(obj)).resolve()
    return {"file": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


class WordGeometryCapture:
    def __init__(self, provenance, preprocessing):
        self.provenance = provenance
        self.preprocessing = preprocessing
        self.crops = []
        self.recognitions = []
        self.tensor_shapes = []

    def serialize(self, raw):
        """Validate alignment against the untouched saved OCR JSON and serialize."""
        raw = _json_value(raw)
        raw = raw.get("res", raw)
        settings = raw.get("model_settings", {})
        if settings.get("use_doc_preprocessor") or settings.get("use_textline_orientation"):
            raise ValueError("Word geometry capture requires document and textline orientation disabled")
        if any(angle != -1 for angle in raw.get("textline_orientation_angles", [])):
            raise ValueError("Word geometry capture rejects textline rotation")
        texts = raw["rec_texts"]
        polygons = raw["rec_polys"]
        word_boxes = raw["text_word_boxes"]
        counts = [len(self.crops), len(self.recognitions), len(self.tensor_shapes),
                  len(texts), len(polygons), len(word_boxes)]
        if len(set(counts)) != 1:
            raise ValueError(f"Crop/recognition/raw line count mismatch: {counts}")
        if "dt_polys" in raw and raw["dt_polys"] != polygons:
            raise ValueError("Detection/raw polygon order differs; filtered recognition is unsupported")
        ratios = [crop["outputShape"][1] / crop["outputShape"][0] for crop in self.crops]
        inference_order = sorted(range(len(self.crops)), key=lambda index: ratios[index])
        channels, height, base_width = self.preprocessing["recImageShape"]
        line_tensors = [None] * len(self.crops)
        for inference_index, line_index in enumerate(inference_order):
            expected_width = int(height * max(base_width / height, ratios[line_index]))
            if expected_width > self.preprocessing["maxImageWidth"]:
                raise ValueError(f"Recognition width clipping is unsupported at line {line_index}: {expected_width}")
            shape = self.tensor_shapes[inference_index]
            if shape != [1, channels, height, expected_width]:
                raise ValueError(f"Recognition tensor shape differs at line {line_index}: {shape}")
            line_tensors[line_index] = shape
        lines = []
        for index, (crop, recognition) in enumerate(zip(self.crops, self.recognitions)):
            if texts[index] != recognition["text"] or polygons[index] != recognition["dtPolygon"]:
                raise ValueError(f"Recognition/raw line order mismatch at line {index}")
            boxes = []
            for polygon in recognition["wordPolygons"]:
                boxes.append([min(p[0] for p in polygon), min(p[1] for p in polygon),
                              max(p[0] for p in polygon), max(p[1] for p in polygon)])
            if boxes != word_boxes[index]:
                raise ValueError(f"Captured/raw word geometry differs at line {index}")
            if "text_word" in raw and recognition["words"] != raw["text_word"][index]:
                raise ValueError(f"Captured/raw word text differs at line {index}")
            if "text_word_region" in raw and recognition["wordPolygons"] != raw["text_word_region"][index]:
                raise ValueError(f"Captured/raw word polygons differ at line {index}")
            lines.append({"lineIndex": index, "crop": crop,
                          "recognition": {**recognition, "tensorShape": line_tensors[index]}})
        return {"schemaVersion": 1, "method": "captured-paddlex-quad-crop-and-ctc",
                "provenance": self.provenance, "recognitionPreprocessing": self.preprocessing,
                "lines": _json_value(lines)}


@contextmanager
def capture_word_geometry(pipeline):
    """Capture one page without replacing any original arguments or return values."""
    version = importlib.metadata.version("paddlex")
    if version != "3.3.13":
        raise ValueError(f"Word geometry capture requires PaddleX 3.3.13, found {version}")
    ocr = pipeline.paddlex_pipeline
    module = inspect.getmodule(type(ocr))
    cropper = ocr._crop_by_polys
    if cropper.det_box_type != "quad":
        raise ValueError("Word geometry capture requires quad detection")
    if ocr.use_doc_preprocessor or ocr.use_textline_orientation:
        raise ValueError("Word geometry capture requires document and textline orientation disabled")
    original_crop = cropper.get_rotate_crop_image
    original_words = module.cal_ocr_word_box
    recognizer = ocr.text_rec_model
    resize = recognizer.pre_tfs["ReisizeNorm"]
    if resize.input_shape is not None:
        raise ValueError("Static recognition input_shape is unsupported")
    if recognizer.batch_sampler.batch_size != 1:
        raise ValueError("Word geometry capture requires recognition batch size 1")
    original_infer = recognizer.infer
    if getattr(original_words, "_word_geometry_capture", False):
        raise RuntimeError("Overlapping word geometry capture contexts are unsupported")
    preprocessing = {"recImageShape": _json_value(resize.rec_image_shape), "inputShape": None,
                     "maxImageWidth": int(resize.max_imgW), "batchSize": 1,
                     "resize": {"class": f"{type(resize).__module__}.{type(resize).__qualname__}",
                                **_source(type(resize))}}
    capture = WordGeometryCapture({"paddlexVersion": version, "pipeline": _source(module),
                                   "crop": _source(original_crop), "wordBox": _source(original_words),
                                   "recognizer": _source(type(recognizer)),
                                   "decoder": _source(type(recognizer.post_op))}, preprocessing)

    def capture_crop(img, points):
        # Snapshot before calling the library; do not substitute copied inputs.
        ordered_points = _json_value(points)
        input_shape = list(img.shape)
        result = original_crop(img, points)
        width = int(max(np.linalg.norm(points[0] - points[1]), np.linalg.norm(points[2] - points[3])))
        height = int(max(np.linalg.norm(points[0] - points[3]), np.linalg.norm(points[1] - points[2])))
        capture.crops.append({"orderedPoints": ordered_points, "inputShape": input_shape,
                              "outputShape": list(result.shape), "preRotationShape": [height, width],
                              "rotationQuarterTurnsCCW": int(height / width >= 1.5),
                              "pixelDtype": str(result.dtype),
                              "pixelSha256": hashlib.sha256(result.tobytes(order="C")).hexdigest()})
        return result

    def capture_words(rec_str, box, rec_word_info):
        evidence = {"text": _json_value(rec_str), "dtPolygon": _json_value(box),
                    "recWordInfo": _json_value(rec_word_info)}
        result = original_words(rec_str, box, rec_word_info)
        evidence.update(words=_json_value(result[0]), wordPolygons=_json_value(result[1]))
        capture.recognitions.append(evidence)
        return result

    def capture_infer(*args, **kwargs):
        tensors = kwargs["x"] if "x" in kwargs else args[0]
        if len(tensors) != 1 or len(tensors[0].shape) != 4 or tensors[0].shape[0] != 1:
            raise ValueError("Expected one NCHW recognition input with batch size 1")
        shape = [int(value) for value in tensors[0].shape]
        result = original_infer(*args, **kwargs)
        capture.tensor_shapes.append(shape)
        return result

    capture_words._word_geometry_capture = True
    owned_crop = "get_rotate_crop_image" in vars(cropper)
    owned_infer = "infer" in vars(recognizer)
    cropper.get_rotate_crop_image = capture_crop
    module.cal_ocr_word_box = capture_words
    recognizer.infer = capture_infer
    try:
        yield capture
    finally:
        if owned_crop:
            cropper.get_rotate_crop_image = original_crop
        else:
            del cropper.get_rotate_crop_image
        module.cal_ocr_word_box = original_words
        if owned_infer:
            recognizer.infer = original_infer
        else:
            del recognizer.infer
