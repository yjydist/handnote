"""Fixed CPU OCR baseline for development-page trajectory redraws."""

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
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


def load_pages(manifest_path):
    manifest = json.loads(manifest_path.read_text())
    pages = manifest["pages"]
    if not pages or len({str(page["page"]) for page in pages}) != len(pages):
        raise ValueError("Expected unique development pages")
    resolved = []
    for page in pages:
        if str(page["page"]) not in {"2", "69", "70"}:
            raise ValueError("This baseline is restricted to development pages 2, 69, 70")
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
        resolved.append({**page, "page": str(page["page"]), "image": str(image), "imageHash": sha256(image)})
    return resolved


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
            results = pipeline.predict(page["image"])
            if len(results) != 1:
                raise RuntimeError(f"Expected one OCR result for page {page['page']}, got {len(results)}")
            destination = output / f"page-{page['page']}.raw.json"
            results[0].save_to_json(str(destination))
            report["pages"].append({**page, "rawResult": destination.name, "seconds": time.perf_counter() - page_started})
            write_json(output / "run.json", report)
            print(f"page {page['page']}: {destination}", flush=True)
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
