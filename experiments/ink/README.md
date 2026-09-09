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

普通应用在 `apps/handnote`，仍通过根兼容入口工作。模型循环归 `@handnote/agent`，渲染与笔迹分别由 `@handnote/renderer`、`@handnote/ink` 提供；来源匹配通过应用的 `@handnote/app/ink-matching` 入口调用。图片授权、资产哈希与 run 事务仍由应用管理。以上自动匹配入口属于历史开发实验，使用原有格式；新的 v2 素材事务与模型驱动入口见本文末节。

首轮实测见 [RESULTS.md](RESULTS.md)，第二轮实测、验证与提交记录见 [RESULTS-round2.md](RESULTS-round2.md)。第二轮保留相同源文件、摘录及片段选择，使用严格完整句段匹配；第 70 页自动覆盖从 2/30 降为 0/30，所有结果仍待人工核验。

## 第三轮 OCR 输入对照

固定三页来源、Markdown、PP-OCRv5 模型及所有阈值，对比整页 2 倍重绘和基线全部 OCR 行的局部重识别。每个行框四周增加半个行高留白，再映射到 2 倍重绘图、向外取整并裁到图片边界。裁剪保留邻行和装饰笔画，不人为清理输入；退化的基线行框明确失败，不悄悄跳过。局部结果只参与诊断，不能进入 Markdown 绑定。

以下 `prepared` 是固定三页准备目录，`baseline` 是第二轮复用的原始完整 OCR 运行目录，`variants` 是 Python 本次输出的新运行目录：

```sh
bun experiments/ink/ocr-inputs.ts --prepared <prepared> --baseline-ocr <baseline> --output <new-inputs>
experiments/ink/ocr/.venv/bin/python experiments/ink/ocr/runner.py --input-manifest <new-inputs>/ocr-input.json
bun experiments/ink/ocr-diagnostics.ts --prepared <prepared> --baseline-ocr <baseline> --variant-ocr <variants> --output <new-diagnostics>
bun experiments/ink/ocr-comparison.ts --prepared <prepared> --baseline-ocr <baseline> --variant-ocr <variants> --output <new-comparison>
```

诊断索引逐行展示文字、分数、退化字框、完整笔画引用与行度量；原坐标内的框相交仅用于并列证据，不代表识别文字或来源相同。局部裁剪输出包括识别到的所有邻行。排版索引提供普通字体、基线自动、整页 2 倍自动三模式 × 三宽度，共 27 张图片。

新输入及结果保留 `inputId`、`variant`、来源和基线 OCR 哈希，局部输入另有 `baselineLineId`、像素裁剪框及原轨迹到裁剪图的变换。消费结果前重建图片和坐标变换进行校验。所有产物目录拒绝覆盖；基线 OCR 原始文件复制到输入目录，绝对证据路径意味着移动目录后需重新准备和运行。Python 记录检测器实际收到的张量尺寸，详见 [OCR 环境说明](ocr/README.md)。

第三轮结论见 [RESULTS-round3.md](RESULTS-round3.md)。覆盖仍以固定摘录为分母，来源与视觉判断均待人工核验。

## 第四轮独立探索

在第三轮已保存的输入上，对照保留整页上下文的局部识别修补、外侧笔画度量、有限句段边界变化，以及连续来源片段的原始空隙。第三轮入口仍保持局部结果仅用于诊断；以下独立入口显式启用后续实验：

```sh
bun experiments/ink/refinement.ts --prepared <prepared> --baseline-ocr <baseline> --variant-ocr <variants> --output <new-refinement>
```

第四轮历史产物为五模式 × 三页 × 三宽度的 45 张图片，方法、负面尝试和限制见 [RESULTS-round4.md](RESULTS-round4.md)。当前入口增加可换行的来源间距模式和 360px 压力宽度，共六模式 × 三页 × 四宽度的 72 张图片，继续保存每个局部结果的取舍及显示片段对应的原始笔画。

完整来源段的重绘仍作为间距对照；新增模式只组合包围盒相交的连续片段，并保留组间换行机会。详情见 [RESULTS-round5.md](RESULTS-round5.md)。

## 第六轮字身高度与绘制对照

冻结第五轮已核验的来源、绑定和可换行间距，比较完整行边界与可测汉字高度中位数两种缩放参考，以及 PNG 与原生 SVG 两种绘制方式：

```sh
bun experiments/ink/readability.ts --prepared <prepared> --baseline-ocr <baseline> --frozen <verified-round5-directory> --output <new-readability>
```

输出三页 × 四宽度 × 四模式的 48 张图片，逐字保存完整笔画归属及无法测量的原因。字高参考只用于原行度量已经可用的实验目标；本轮历史入口只在受控浏览器中替换由相同原始点生成的 SVG，当时正式渲染入口只接受 PNG。冻结报告、基线 OCR 与来源失效会拒绝运行，输出拒绝覆盖。结果与样本局限见 [RESULTS-round6.md](RESULTS-round6.md)。

## 第七轮字框重叠诊断

固定原 OCR 的文字、分数、行框、字序和所有阈值，在相邻字框的重叠区分别取 1/4、1/2、3/4 分界，检查完整笔画样本对定位变化的敏感性：

```sh
bun experiments/ink/word-box-diagnostics.ts --prepared <prepared> --baseline-ocr <baseline> --output <new-word-box-diagnostics>
```

输出全部 67 行 × 四模式的 268 张叠图，原始和合成 OCR 分开保存。退化、倒序和无效切分整行不改；合成关联仅用于诊断，不进入自动绑定。Paddle 字框机制、分界实验及保留的负面结果见 [RESULTS-round7.md](RESULTS-round7.md)。

## 第八轮实际裁图坐标回映

使用运行器的 `--capture-word-geometry` 保存实际 OCR 裁图四边形、CTC 列信息和识别张量尺寸，再比较原字框与从实际识别裁图投回输入图的字框：

```sh
experiments/ink/ocr/.venv/bin/python experiments/ink/ocr/runner.py --input-manifest <prepared>/ocr-input.json --capture-word-geometry
bun experiments/ink/geometry-diagnostics.ts --prepared <prepared> --baseline-ocr <baseline> --geometry-ocr <captured-run> --output <new-geometry-comparison>
```

固定三页全部 67 行，输出 134 张叠图和四模式 × 三页 × 四宽度的 48 张排版。原 OCR 与合成字框分开保存，校验输入身份、实现哈希和实际裁图变换；重复输出被拒绝。倾斜行零高框修复后的分数阻塞，以及正文度量受另一行影响的回退证据，见 [RESULTS-round8.md](RESULTS-round8.md)。

## 模型驱动的整页原笔迹实验

```sh
bun run eval:ink:full --output runs/ink-full-page-01 --config config.yaml
# 针对失败页的新运行，保留上次证据
bun run eval:ink:full --output runs/ink-full-page-02 --config config.yaml --pages 2
```

入口只读取开发页 2、69、70 的原图和完整 points，固定来源哈希；不读取旧实验的 Markdown、OCR、字框或人工片段。复用当前模型配置，每页最多 50 步，保留所有中间图。输出目录必须不存在；中断后使用新目录重新运行，不恢复模型。七页留出及新增多页数据不参与此入口。

每页使用正式 Agent 与 v2 修订事务，保留工具轨迹、编号/实际素材预览、模型实际收到的 JPEG、素材描述/SVG、各次修订以及审查时的四种宽度。运行结束后为当前有效修订导出 360、720、1200、1600 四宽成品与素材依赖索引，记录耗时、模型步骤/用量、失败原因和审计。没有有效修订的失败运行仍保留来源、工具轨迹和已生成素材。

总索引为 `experiment.json`、`results.json`；每个 run 的 `experiment/evidence.json` 记录成品位置、哈希、布局反馈和素材清单。`runStatus: complete` 仅表示工具事务已确认，不能代替整页视觉验收。所有判断均为 `pending-human-review`，验收字段保持 `not-assessed`，需另行逐页对照原图、素材和成品。正式 CLI 的轨迹输入必须等待三页成品验收通过。
