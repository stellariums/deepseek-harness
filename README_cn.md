# 三省制 Agent 治理 · sansheng

本仓库是 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 的 fork，`sansheng-mvp` 分支承载[三省制](packages/science/sansheng/README.zh.md)治理插件的 MVP：一个面向科研场景的多 Agent 权力制衡层。基于上游 `0.2.1-alpha.2`。

## 这是什么

让多个 Agent 协作完成研究课题，但用**制度**而不是提示词来保证它们不能架空人类决策者：

| 角色 | 实现 | 权力 | 禁止 |
|---|---|---|---|
| 皇帝（用户） | 人 | 唯一的批准、否决、推翻权 | — |
| 太监 | 根会话 Agent | 转译、调度三省、汇报 | 批准、改写各省意见、读写记录 |
| 中书 | 子 Agent | 起草研究方案与验收标准 | 写文件、执行、看门下 |
| 门下 | 子 Agent（不同厂商模型） | 审核/封驳、按锁定标准验收 | 改方案、写文件、看中书推理 |
| 尚书 | 子 Agent，可再派子 Agent | 决定"怎么做"、写工作区 | 改目标、改验收标准、自己验收 |

四条底线：朱批只能出自用户本人；中书门下隔离且用不同模型；验收标准朱批后按哈希锁定；记录存放在所有 Agent 都无权读写的目录，原件永远可查。

## 当前进度

MVP 已完成并用真实模型全流程验证（2026-10-15，第 8 轮试点）：下旨 → 转译 → 朱批 → 拟旨 → 门下封驳 → 修订 → 朱批 → 尚书执行（真实 shell，交付 4 件文件）→ 门下独立复核验收 → 复命 → 结案，全程约 21 分钟。门下的封驳发现了验收标准里 π(9999) 的数学错误，验收阶段独立重跑脚本并审计了源码防硬编码。

- 完整设计与实测记录：[packages/science/sansheng/HANDOFF.md](packages/science/sansheng/HANDOFF.md)
- 插件文档（中文）：[packages/science/sansheng/README.zh.md](packages/science/sansheng/README.zh.md)
- 代码：[packages/science/sansheng/src/](packages/science/sansheng/src/)（118 个单元测试，覆盖率 100%）

尚未完成：dsh 网页界面实测、中书方案规模约束、性能优化。详见 HANDOFF 第 4 节。

## 怎么跑

```sh
pnpm install                          # Node ^22.19 || >=24，pnpm workspaces
pnpm vitest run packages/science/sansheng   # 单元测试（无需 key）
```

真实模型试点需要网关 key（约 21 分钟，需在命令前 source `.local/env.sh`，细节见 HANDOFF 第 6 节）：

```sh
source .local/env.sh && source .local/secrets.env
SANSHENG_TRACE=trace.log pnpm vitest run --config vitest.e2e.config.ts \
  packages/science/sansheng/tests/ustc.e2e.ts
```

在 dsh 网页界面中使用的叠加配置在 [packages/science/sansheng/profile/](packages/science/sansheng/profile/)，人机交互命令为 `/xiazhi`（下旨）、`/zhupi`（朱批）、`/zouzhe`（直接阅折）。

## 上游

上游仓库、构建说明和完整文档见 [README.md](README.md) 与 [官方文档](https://deepseek-harness.github.io/deepseek-harness/)。本分支只通过 dsh 的公开扩展点接入，未改动上游核心代码。
