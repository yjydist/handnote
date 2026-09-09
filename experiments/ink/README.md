# 原笔迹开发实验

首轮范围关联 issue #39：独立 Renderer、完整轨迹片段、排版对照、固定 OCR 与保守来源匹配。实验使用开发页 `2、69、70`，其余七页留待独立评测。所有转写、笔画分组、行高与基线均为 `pending-human-review`；没有人工真值，不输出准确率。

从仓库根目录运行，以下输出目录必须尚不存在：

```sh
bun install --frozen-lockfile
bunx playwright install chromium
bun run eval:ink:prepare --output runs/ink-experiments/my-input
bun run eval:ink --input runs/ink-experiments/my-input --output runs/ink-experiments/my-comparison
```

准备过程保留原始 JSON、原图、黑色重绘、完整笔画编号、候选框叠图、透明片段及固定 Markdown。对照生成三页 × 三宽度（720、1200、1600）× 三模式（字体、首轮自然度量、共享行度量），从输出 `index.html` 浏览。首轮单字方框对照保留在旧运行产物；当前新增整行编号图与共享度量。第 69 页预测行含归属未定的笔画 883，新度量明确回退。

按 [OCR 环境说明](ocr/README.md) 安装锁定的独立 Python 环境，然后执行：

```sh
experiments/ink/ocr/.venv/bin/python experiments/ink/ocr/runner.py --input-manifest runs/ink-experiments/my-input/ocr-input.json
bun run eval:ink:auto --prepared runs/ink-experiments/my-input --ocr-run runs/ink-experiments/ocr/<本次运行目录> --output runs/ink-experiments/my-automatic
```

自动实验在创建输出前，验证固定来源、Markdown、重绘 PNG 哈希、坐标变换和 OCR `input_path`。运行结果保存原始 OCR、完整来源候选、绑定、逐层回退、耗时及实际图片。报告中的覆盖分母仅为固定摘录的非空白可见字符；来源候选统计则覆盖完整开发页，两者不能直接相除。阈值是尚未校准的开发默认值。

可根据固定开发来源及自动结果生成聚落实例、重复天气和退化字框的核验材料：

```sh
bun experiments/ink/review-cases.ts --prepared runs/ink-experiments/my-input --automatic runs/ink-experiments/my-automatic --output runs/ink-experiments/my-review
```

核验索引保留原 OCR 行号、字框及完整笔画编号。字框附近的未分配笔画只表示几何邻近，不能据此认定字归属；所有案例仍待人工核验。

这些命令保留既有产物，生成文件位于 Git 忽略的 `runs/`。复现时需要原始开发数据以及对应 OCR 输入图片；原始 OCR 记录包含绝对图片路径，移动实验目录后应重新运行 OCR。锁定模型、依赖、固定小型 OCR 测试结果及实验代码随仓库提交，大型模型和运行产物不提交。

普通应用在 `apps/handnote`，仍通过根兼容入口工作。模型循环归 `@handnote/agent`，渲染与笔迹分别由 `@handnote/renderer`、`@handnote/ink` 提供；来源匹配通过应用的 `@handnote/app/ink-matching` 入口调用。图片授权、资产哈希与 run 事务仍由应用管理。自动匹配是开发实验，未接入正式 `--ink`，未升级生产存储格式。

首轮实测见 [RESULTS.md](RESULTS.md)，第二轮实测、验证与提交记录见 [RESULTS-round2.md](RESULTS-round2.md)。第二轮保留相同源文件、摘录及片段选择，使用严格完整句段匹配；第 70 页自动覆盖从 2/30 降为 0/30，所有结果仍待人工核验。
