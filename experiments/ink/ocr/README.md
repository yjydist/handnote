# 固定 OCR 开发基线

此运行器只接收开发页 `2、69、70` 的轨迹重绘 PNG。它不读取留出页，不修改原始数据，也不进入普通 Bun 离线测试。识别结果和候选转写均待人工核验；本实验不产生准确率结论。

从仓库根目录安装已锁定的独立环境：

```sh
uv venv --python 3.12 experiments/ink/ocr/.venv
uv pip sync --python experiments/ink/ocr/.venv/bin/python experiments/ink/ocr/requirements.lock --require-hashes
experiments/ink/ocr/.venv/bin/python experiments/ink/ocr/runner.py --input-manifest /absolute/path/to/ocr-input.json
```

输入 manifest：

```json
{
  "pages": [
    {
      "page": "2",
      "image": "page-2.png",
      "transform": { "scale": 1, "translateX": 16, "translateY": 16 }
    }
  ]
}
```

`image` 可为绝对路径或相对于 manifest 的路径。变换约定是 `imageX = sourceX * scale + translateX`，Y 同理；OCR 框始终保留图像坐标，调用方使用保存的变换映射回原始轨迹。整页重绘图必须包含完整轨迹、统一黑色和白色背景，不采用原始截图的未知坐标变换。行图只裁切基线 OCR 行定位所确定的重绘图区域。

第三轮允许同一开发页提交多个输入，以 `variant` 和精确的 `inputId` 区分：

- 整页 2x：`variant: "page-2x"`、`inputId: "page-2-2x"`，不得携带 `crop` 或 `baselineLineId`。
- 基线第 0 行 2x：`variant: "line-2x"`、`inputId: "page-2-line-0-2x"`、`baselineLineId: 0`，以及 `crop: {"left": 0, "top": 20, "width": 200, "height": 40}`。裁切框在 2x 整页 PNG 上以整数像素表示，左/上偏移非负，宽/高为正。`transform` 直接从源轨迹映射到裁切后的 PNG。

这两种输入均须提供 64 位小写十六进制 SHA-256 `sourceHash`、`baselineOcrHash`、`imageHash`；运行器验证图像实际字节与 `imageHash` 一致，并保留其他来源元数据（例如 `baselineOcrFile`）。源数据和基线 OCR 的字节核验由输入生成器负责，运行器校验这两项哈希格式。重复身份、错配页号/行号或身份路径、未知变体及非法裁切框会在加载模型前失败。旧输入继续按页号唯一，输出仍为 `page-2.raw.json`；新输入输出为 `<inputId>.raw.json`。

默认输出到 `runs/ink-experiments/ocr/<UTC时间>-<随机ID>/`，每次创建新目录；`--output-root` 可改变父目录。产物包括输入与图像哈希、完整原始 OCR JSON、模型文件哈希、安装包版本、显式参数、实际合并的 `pipeline.yaml`、各输入耗时和运行状态。每个成功输入的 `run.json.pages` 记录 `inputDimensions`（PNG 原始宽高）和 `detectionPreprocessing`。后者通过临时包裹当前检测器的 `infer(x=x)` 捕获实际送入推理的 NCHW 张量形状，记录 `method: "captured-inference-input"`、宽高、实际检测参数、安装实现的类名/路径/文件哈希；捕获结束后恢复原推理对象。这里记录的是实际预处理后的张量，不是根据 736 参数估算的尺寸。锁定 PaddleX 的 `TextDetPredictor.process` 在 Resize、Normalize、ToCHW、ToBatch 后将该张量直接交给推理；其 Resize 还受实际 `max_side_limit` 和 32 像素对齐约束。异常以非零退出码报告，并保留 `error.txt` 及已有成功页结果。

模型固定为 `PP-OCRv5_server_det` 和 `PP-OCRv5_server_rec`，Python 3.12、PaddleOCR 3.3.1、PaddlePaddle 3.2.2。传递依赖记录在 `requirements.lock`，模型权重及模型配置以 `models.lock.json` 的 SHA-256 校验。首次运行从 Paddle 官方 BOS 下载至本目录忽略的 `.models/`；哈希不符会失败，不自动接受新模型。模型名称、阈值、CPU 4 线程、FP32、识别批量 1、方向/矫正全关闭和 `return_word_box=True` 均固定于运行器。关闭 MKL-DNN，以保持已验证的 macOS arm64 CPU 路径。

API 参数依据 [PaddleOCR 3.3.1 官方文档](https://www.paddleocr.ai/v3.3.1/en/version3.x/pipeline_usage/OCR.html)，并通过当前锁定安装包和实际推理验证。模型原始来源为 Paddle 官方 `paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_server_{det,rec}_infer.tar`。

离线边界检查（无需加载模型）：

```sh
experiments/ink/ocr/.venv/bin/python -m unittest discover -s experiments/ink/ocr -p 'test_*.py'
```

可选 `--capture-word-geometry` 另存 `<inputId>.word-geometry.json`，默认命令保持原行为。记录实际排序后的裁图四边形、旋转前后尺寸、裁图像素哈希、CTC 解码列、原字框、识别器实际 NCHW 输入形状，以及从裁图投回输入图的字框。`run.json` 保存几何文件哈希和捕获实现哈希；无效映射逐行记录拒绝原因，捕获或身份不一致使运行失败。

该路径只支持当前锁定的四边形裁图、关闭文档和文字方向预处理、识别批量 1 及动态缩放配置；遇到静态缩放、宽度截断或实际张量不符时拒绝猜测。捕获器在正常和异常退出后都恢复原调用。名义字框范围 W/H 与像素中心旋转 W−1 的矩阵分开保存。记录并不包含 logits 或推理张量内容；CTC 字宽估计仍是原算法，回映结果仍待人工核验。实际实验与复现命令见 [第八轮报告](../RESULTS-round8.md)。
