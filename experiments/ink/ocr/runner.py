"""Fixed CPU OCR baseline for development-page trajectory redraws."""

import argparse
import hashlib
import importlib.metadata
import inspect
import json
import math
import os
from pathlib import Path
import platform
import re
import sys
import time
import traceback
from datetime import datetime, timezone
from uuid import uuid4

ROOT = Path(__file__).resolve().parent
MODEL_NAMES = ("PP-OCRv5_server_det", "PP-OCRv5_server_rec")
PARAMETERS = {
    "text_detection_model_name": MODEL_NAMES[0],
    "text_recognition_model_name": MODEL_NAMES[1],
    "device": "cpu",
    "enable_hpi": False,
    "use_tensorrt": False,
    "precision": "fp32",
    "enable_mkldnn": False,
    "cpu_threads": 4,
    "use_doc_orientation_classify": False,
    "use_doc_unwarping": False,
    "use_textline_orientation": False,
    "return_word_box": True,
    "text_recognition_batch_size": 1,
    "text_det_limit_side_len": 736,
    "text_det_limit_type": "min",
    "text_det_thresh": 0.3,
    "text_det_box_thresh": 0.6,
    "text_det_unclip_ratio": 1.5,
    "text_rec_score_thresh": 0.0,
}


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def input_id(page):
    page_number = str(page["page"])
    variant = page.get("variant")
    if variant is None:
        if any(key in page for key in ("variant", "inputId", "crop", "baselineLineId")):
            raise ValueError("Variant metadata requires page-2x or line-2x")
        return f"page-{page_number}"
    if not isinstance(variant, str) or variant not in {"page-2x", "line-2x"}:
        raise ValueError("Invalid variant")
    for key in ("sourceHash", "baselineOcrHash", "imageHash"):
        value = page.get(key)
        if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
            raise ValueError(f"Expected SHA-256 {key}")
    if variant == "page-2x":
        if any(key in page for key in ("crop", "baselineLineId")):
            raise ValueError("Whole-page variant cannot have crop or baselineLineId")
        expected = f"page-{page_number}-2x"
    else:
        line_id = page.get("baselineLineId")
        if type(line_id) is not int or line_id < 0:
            raise ValueError("Expected nonnegative integer baselineLineId")
        crop = page.get("crop")
        if not isinstance(crop, dict) or set(crop) != {"left", "top", "width", "height"}:
            raise ValueError("Expected crop left, top, width, height")
        for key, value in crop.items():
            minimum = 0 if key in {"left", "top"} else 1
            if type(value) is not int or value < minimum:
                raise ValueError(f"Invalid crop {key}")
        expected = f"page-{page_number}-line-{line_id}-2x"
    if page.get("inputId") != expected:
        raise ValueError(f"Expected inputId {expected}")
    return expected


def load_pages(manifest_path):
    manifest = json.loads(manifest_path.read_text())
    pages = manifest["pages"]
    if not isinstance(pages, list) or not pages:
        raise ValueError("Expected unique development inputs")
    resolved = []
    identities = set()
    for page in pages:
        if str(page["page"]) not in {"2", "69", "70"}:
            raise ValueError("This baseline is restricted to development pages 2, 69, 70")
        identity = input_id(page)
        if identity in identities:
            raise ValueError("Expected unique development inputs")
        identities.add(identity)
        transform = page["transform"]
        for key in ("scale", "translateX", "translateY"):
            value = transform[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"Invalid transform {key}")
        if transform["scale"] <= 0:
            raise ValueError("Transform scale must be positive")
        image = (manifest_path.parent / page["image"]).resolve(strict=True)
        if image.suffix.lower() != ".png":
            raise ValueError("Expected a trajectory redraw PNG")
        image_hash = sha256(image)
        if page.get("variant") is not None and page["imageHash"] != image_hash:
            raise ValueError(f"imageHash differs from image content: {identity}")
        resolved.append({**page, "page": str(page["page"]), "image": str(image), "imageHash": image_hash})
    return resolved


def predict_with_dimensions(pipeline, image_path):
    from PIL import Image

    with Image.open(image_path) as image:
        input_dimensions = {"width": image.width, "height": image.height}
    ocr = pipeline.paddlex_pipeline
    detector = ocr.text_det_model
    original_infer = detector.infer
    shapes = []

    def capture_infer(*args, **kwargs):
        tensors = kwargs["x"] if "x" in kwargs else args[0]
        if len(tensors) != 1 or len(tensors[0].shape) != 4:
            raise RuntimeError("Expected one NCHW detection input tensor")
        shapes.append([int(value) for value in tensors[0].shape])
        return original_infer(*args, **kwargs)

    # The locked TextDetPredictor passes its fully preprocessed batch to infer(x=x).
    detector.infer = capture_infer
    try:
        results = list(pipeline.predict(image_path))
    finally:
        detector.infer = original_infer
    if len(shapes) != 1 or shapes[0][0] != 1:
        raise RuntimeError("Expected one detection batch for one input image")
    shape = shapes[0]
    implementations = {
        "predictor": type(detector),
        "resize": type(detector.pre_tfs["Resize"]),
        "inference": type(original_infer),
    }
    provenance = {
        name: {"class": f"{cls.__module__}.{cls.__qualname__}",
               "file": inspect.getfile(cls), "sha256": sha256(Path(inspect.getfile(cls)))}
        for name, cls in implementations.items()
    }
    preprocessing = {
        "method": "captured-inference-input",
        "tensorLayout": "NCHW",
        "tensorShape": shape,
        "width": shape[3],
        "height": shape[2],
        "parameters": ocr.get_text_det_params(),
        "provenance": provenance,
    }
    return results, input_dimensions, preprocessing


def model_files():
    from paddlex.inference.utils.official_models import official_models

    expected = json.loads((ROOT / "models.lock.json").read_text())
    models = {}
    for name in MODEL_NAMES:
        directory = Path(official_models[name])
        files = {
            path.name: sha256(path)
            for path in sorted(directory.iterdir())
            if path.is_file() and path.name.startswith("inference.")
        }
        if files != expected[name]:
            raise ValueError(f"Model content differs from models.lock.json: {name}")
        models[name] = {"directory": str(directory), "files": files}
    return models


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-manifest", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, default=ROOT.parents[2] / "runs/ink-experiments/ocr")
    parser.add_argument("--capture-word-geometry", action="store_true",
                        help="Save actual recognition crops and CTC geometry for a separate coordinate diagnostic")
    args = parser.parse_args()
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError("Use the isolated Python 3.12 environment")
    for package, version in {"paddleocr": "3.3.1", "paddlepaddle": "3.2.2"}.items():
        if importlib.metadata.version(package) != version:
            raise RuntimeError(f"Expected {package}=={version}; sync requirements.lock")
    pages = load_pages(args.input_manifest.resolve(strict=True))
    output = args.output_root.resolve() / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
    output.mkdir(parents=True, exist_ok=False)
    os.environ["PADDLE_PDX_CACHE_HOME"] = str(ROOT / ".models")
    os.environ["PADDLE_PDX_MODEL_SOURCE"] = "bos"
    os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    report = {
        "status": "running",
        "annotationStatus": "pending-human-review",
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "python": sys.version,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "packages": dict(sorted((dist.metadata["Name"], dist.version) for dist in importlib.metadata.distributions())),
        "requirementsHash": sha256(ROOT / "requirements.lock"),
        "modelLockHash": sha256(ROOT / "models.lock.json"),
        "parameters": PARAMETERS,
        "environment": {key: os.environ[key] for key in ("PADDLE_PDX_CACHE_HOME", "PADDLE_PDX_MODEL_SOURCE", "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK")},
        "coordinateConvention": "imageX = sourceX * scale + translateX; imageY = sourceY * scale + translateY",
        "pages": [],
    }
    if args.capture_word_geometry:
        report["wordGeometryCodeHashes"] = {
            name: sha256(ROOT / name)
            for name in ("runner.py", "word_geometry_capture.py", "rectified_word_mapping.py")
        }
    write_json(output / "input.json", {"pages": pages})
    write_json(output / "run.json", report)
    started = time.perf_counter()
    pipeline = None
    try:
        models = model_files()
        report["models"] = models
        from paddleocr import PaddleOCR

        pipeline = PaddleOCR(
            **PARAMETERS,
            text_detection_model_dir=models[MODEL_NAMES[0]]["directory"],
            text_recognition_model_dir=models[MODEL_NAMES[1]]["directory"],
        )
        pipeline.export_paddlex_config_to_yaml(str(output / "pipeline.yaml"))
        report["initializationSeconds"] = time.perf_counter() - started
        for page in pages:
            page_started = time.perf_counter()
            capture = None
            if args.capture_word_geometry:
                from word_geometry_capture import capture_word_geometry

                with capture_word_geometry(pipeline) as capture:
                    results, input_dimensions, preprocessing = predict_with_dimensions(pipeline, page["image"])
            else:
                results, input_dimensions, preprocessing = predict_with_dimensions(pipeline, page["image"])
            if len(results) != 1:
                raise RuntimeError(f"Expected one OCR result for page {page['page']}, got {len(results)}")
            destination = output / f"{input_id(page)}.raw.json"
            results[0].save_to_json(str(destination))
            geometry_record = {}
            if capture is not None:
                from rectified_word_mapping import map_rectified_words

                geometry = capture.serialize(json.loads(destination.read_text()))
                geometry["annotationStatus"] = "pending-human-review"
                geometry["rawResultHash"] = sha256(destination)
                geometry["inputImageHash"] = page["imageHash"]
                geometry["inputId"] = input_id(page)
                failures = 0
                for line in geometry["lines"]:
                    try:
                        mapping = map_rectified_words(
                            line["crop"]["orderedPoints"], line["crop"]["outputShape"],
                            line["recognition"]["text"], line["recognition"]["recWordInfo"],
                        )
                        if mapping["rectifiedWords"] != line["recognition"]["words"]:
                            raise ValueError("Rectified word order differs from original recognition")
                        line["mapping"] = {"status": "mapped", **mapping}
                    except ValueError as error:
                        failures += 1
                        line["mapping"] = {"status": "rejected", "error": str(error)}
                geometry_path = output / f"{input_id(page)}.word-geometry.json"
                write_json(geometry_path, geometry)
                geometry_record = {"wordGeometry": {
                    "file": geometry_path.name, "sha256": sha256(geometry_path),
                    "lineCount": len(geometry["lines"]), "rejectedMappings": failures,
                }}
            report["pages"].append({**page, "rawResult": destination.name,
                                  "inputDimensions": input_dimensions,
                                  "detectionPreprocessing": preprocessing,
                                  "seconds": time.perf_counter() - page_started,
                                  **geometry_record})
            write_json(output / "run.json", report)
            print(f"page {page['page']}: {destination}", flush=True)
        if args.capture_word_geometry:
            for name, expected in report["wordGeometryCodeHashes"].items():
                if sha256(ROOT / name) != expected:
                    raise RuntimeError(f"Word geometry code changed during inference: {name}")
        report["status"] = "complete"
    except Exception as error:
        report["status"] = "failed"
        report["error"] = {"type": type(error).__name__, "message": str(error)}
        (output / "error.txt").write_text(traceback.format_exc())
        raise
    finally:
        report["totalSeconds"] = time.perf_counter() - started
        write_json(output / "run.json", report)
        if pipeline is not None:
            pipeline.close()
        print(f"OCR run: {output}", flush=True)


if __name__ == "__main__":
    main()
