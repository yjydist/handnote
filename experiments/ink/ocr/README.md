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

`image` 可为绝对路径或相对于 manifest 的路径。变换约定是 `imageX = sourceX * scale + translateX`，Y 同理；OCR 框始终保留图像坐标，调用方使用保存的变换映射回原始轨迹。重绘图必须包含完整轨迹、统一黑色和白色背景，不采用原始截图的未知坐标变换。

默认输出到 `runs/ink-experiments/ocr/<UTC时间>-<随机ID>/`，每次创建新目录；`--output-root` 可改变父目录。产物包括输入与图像哈希、完整原始 OCR JSON、模型文件哈希、安装包版本、显式参数、实际合并的 `pipeline.yaml`、各页耗时和运行状态。异常以非零退出码报告，并保留 `error.txt` 及已有成功页结果。

模型固定为 `PP-OCRv5_server_det` 和 `PP-OCRv5_server_rec`，Python 3.12、PaddleOCR 3.3.1、PaddlePaddle 3.2.2。传递依赖记录在 `requirements.lock`，模型权重及模型配置以 `models.lock.json` 的 SHA-256 校验。首次运行从 Paddle 官方 BOS 下载至本目录忽略的 `.models/`；哈希不符会失败，不自动接受新模型。模型名称、阈值、CPU 4 线程、FP32、识别批量 1、方向/矫正全关闭和 `return_word_box=True` 均固定于运行器。关闭 MKL-DNN，以保持已验证的 macOS arm64 CPU 路径。

API 参数依据 [PaddleOCR 3.3.1 官方文档](https://www.paddleocr.ai/v3.3.1/en/version3.x/pipeline_usage/OCR.html)，并通过当前锁定安装包和实际推理验证。模型原始来源为 Paddle 官方 `paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_server_{det,rec}_infer.tar`。

离线边界检查（无需加载模型）：

```sh
experiments/ink/ocr/.venv/bin/python -m unittest discover -s experiments/ink/ocr -p 'test_*.py'
```
