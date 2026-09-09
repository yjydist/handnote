---
name: decision-rich-commits
description: |-
  按语义与决策设计 commit 边界, 编写兼容 Conventional Commits 且保留背景, 决策和理由的提交说明.
  触发时机:
  - 用户要求提交变更, 拆分或整理提交, 编写或改进 commit message.
  - 当前任务已包含提交要求并进入提交准备阶段, 需要确定变更如何分组及记录哪些理由.
  不适用:
  - 仅完成编码, 当前任务没有提交或提交说明相关要求.
  - 需要调查已有代码的历史设计原因, 而非组织新提交.
metadata:
  short-description: 设计清晰的 commit 边界和决策型 commit message
---

# 写出可以承担 ADR 的 commit history

按当前请求和已有授权选择工作范围. 仅请求提交划分或 message 时交付方案或文本; stage, 创建提交和改写历史等操作遵循已有授权, 不因加载本技能扩大权限.

目标是让未来的人或 agent 只看 Git history, 就能理解:

- 改了什么
- 为什么要改
- 为什么选择这个方案
- 这个 commit 和前后决策是什么关系

高质量 history 同时依赖两件事:

1. commit 边界合理.
2. commit message 保存了真正有价值的理由.

先设计 commit, 再写 message.

## 工作流程

### 1. 先检查全部变更

至少检查:

```bash
git status --short
git diff --stat
git diff
git diff --cached --stat
git diff --cached
```

不要直接为当前 staged 内容生成 message. 先判断这些变更是否应该属于同一个 commit.

### 2. 设计 commit 边界

一个 commit 应该表达一个完整且连贯的变化.

判断标准:

- 是否只有一个主要目的
- 是否只有一套主要理由
- 是否可以独立 review
- 是否可以独立理解
- 是否可以合理 revert
- 是否留下一个正常, 可理解的代码状态

不要按文件数量, 目录或 diff 大小机械拆分.

应该按语义和决策边界拆分.

好例子:

```text
commit 1: 重构 token parser, 不改变行为
commit 2: 支持 signing key rotation 期间同时接受新旧 key
commit 3: 迁移完成后删除旧的单 key 配置
```

差例子:

```text
commit 1: 修改 auth.ts
commit 2: 修改 config.ts
commit 3: 修改 auth tests
```

### 3. 决定哪些变化应该拆开

通常应该拆开:

- 解决不同问题的变化
- 理由不同的变化
- cleanup 和行为变化
- refactor 和依赖它的行为变化
- migration 和 legacy removal
- 主任务和顺手发现的独立 bug fix
- 可以独立 review 或 revert 的变化

如果两个变化需要不同的背景, 决策或理由, 通常应该拆成不同 commit.

### 4. 决定哪些变化应该放在一起

不要为了让 commit 很小而过度拆分.

通常应该放在一起:

- 实现和直接对应的测试
- bug fix 和 regression test
- 必须同时变化才能保持正确行为的代码和配置
- 一个决策所必需的最小完整改动

一个 commit 最好保持仓库处于可构建, 可测试或至少逻辑完整的状态. 具体要求跟随仓库现有规范.

### 5. 对大型迁移保留演进顺序

大型架构变化通常不应该压成一个巨大 commit.

优先保留有意义的状态转换:

```text
1. 引入新路径, 保留兼容
2. 迁移调用方, 数据或配置
3. 让新路径成为默认或唯一权威路径
4. 满足删除条件后移除旧路径
```

每个 commit 都应该说明当前这一步为什么存在.

### 6. 清理无意义的中间 commit

开发过程中可以出现临时 commit, 但发布长期 history 前应处理这些内容:

- fix typo from previous commit
- make tests pass
- lint previous commit
- address review comment
- finish previous incomplete commit

如果它们没有独立价值, 使用 fixup 或 squash 合并到真正对应的 commit.

### 7. 精确 stage

需要时使用:

```bash
git add -p
```

不要因为几个变化碰巧在同一个文件里, 就把它们放进同一个 commit.

### 8. 最后再写 commit message

message 必须描述这个 commit 实际包含的内容, 不是整个任务, PR 或最终目标.

## Commit message 基本结构

保持 Conventional Commits 兼容:

```text
<type>[optional scope][!]: <description>
```

例如:

```text
feat(auth): support overlapping signing keys during rotation
```

常见 type:

- `feat`
- `fix`
- `refactor`
- `perf`
- `test`
- `docs`
- `build`
- `ci`
- `chore`

优先遵守仓库已有的 type 和 scope 约定.

header 描述结果, 不要写模糊的操作过程.

好:

```text
feat(auth): support overlapping signing keys during rotation
```

差:

```text
feat(auth): update auth code
```

## 根据决策密度决定 message 长度

不是每个 commit 都需要完整 ADR.

### Level 0: 简单或机械变化

例如 typo, format, generated file refresh.

通常只需要 header:

```text
docs(readme): fix installation command typo
```

### Level 1: 普通行为变化

当理由不能从 diff 直接看出时, 增加简短 body:

```text
<type>(<scope>): <description>

背景:
<为什么需要这个变化>

决策:
<选择了什么, 以及最关键的原因>
```

### Level 2: 重要决策

用于架构, API, 数据模型, 持久化, 安全, 性能, 并发, 兼容性, 部署或重要运维行为.

推荐结构:

```text
<type>(<scope>): <description>

背景:
<问题和约束>

决策:
<选择的方案>

理由:
<为什么这个方案更适合当前约束>

备选方案:
- <真实考虑过的方案>: <没有选择的原因>

影响:
- <重要权衡, 新不变量, 迁移要求或后续义务>

Decision-Relates-To: <sha>
Decision-Supersedes: <sha>
Decision-Follows-Up: <sha>
Refs: <issue-or-ticket>
```

只保留有长期价值的部分. 没有真实信息就不要写对应 section.

## Body 应该记录什么

### 背景

说明为什么必须做这个变化.

优先记录:

- 原方案哪里不够
- 必须保持什么不变量
- 有什么兼容要求
- 有什么性能, 安全或运维约束
- 为什么现在需要改变

不要把 diff 过程重新描述一遍.

### 决策

说明这个 commit 建立了什么行为, 规则, 架构或实现策略.

### 理由

说明为什么选择这个方案.

重点写代码本身无法可靠表达的信息.

### 备选方案

只写真实考虑过的方案.

不要为了让 message 看起来完整而编造备选方案.

### 影响

记录这个决策带来的长期结果, 例如:

- 新的不变量
- 兼容窗口
- 暂时保留的 legacy path
- migration 要求
- 性能或存储成本
- 运维责任
- 未来删除条件

## 决策关系 trailer

当 commit 和历史决策有明确关系时, 可以使用 Git trailer:

```text
Decision-Relates-To: <sha>
Decision-Supersedes: <sha>
Decision-Follows-Up: <sha>
Refs: <issue-or-ticket>
```

使用规则:

- `Decision-Relates-To`: 与另一个决策相关, 但不是替代关系.
- `Decision-Supersedes`: 当前决策明确替代旧决策.
- `Decision-Follows-Up`: 当前 commit 是前一个决策的计划内后续步骤.
- `Refs`: 关联 issue, ticket 或其他稳定引用.

不要为了建立关系图而滥用 trailer.

## 最终检查

commit 前检查:

- 这个 commit 是否只有一个连贯故事
- staged 内容是否刚好支持这个故事
- implementation 和必要测试是否完整
- 是否混入独立 cleanup 或顺手修改
- header 是否准确描述结果
- body 是否解释了真正重要的 why
- 是否写入了未经确认的理由或备选方案
- 是否需要连接之前的决策 commit

最后问自己:

```text
如果未来的 agent 只找到这个 commit, 它能否说明改了什么, 为什么这样改, 以及 revert 这个 commit 会撤销什么?
```

如果答案包含多个无关故事, 应该拆分 commit.

如果拆分后单个 commit 已经没有独立意义, 应该合并.

## 不要做

- 不要为当前 staged 内容直接生成 message 而不检查 commit 边界.
- 不要按文件机械拆 commit.
- 不要把多个独立决策塞进一个 commit.
- 不要把一个完整决策拆成没有意义的小碎片.
- 不要编造背景, 理由, 备选方案, benchmark, incident 或 requirement.
- 不要让 message 只复述 diff.
- 不要把临时开发步骤当成长期决策 history.