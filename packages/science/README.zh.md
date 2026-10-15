---
description: "science 组的包映射：以角色分离、批准权留给人的 agent 治理层运行研究工作流，供浏览该组的读者导航。"
kind: "package-group"
---

# science/ — 受治理的研究工作流

[English](README.md) | 中文

## 概述

`science/` 组收纳研究工作的治理层：课题在角色分离的 agent——起草、审核、执行——之间推进，由一个传达型根会话协调，而每一次批准与否决都保留给人。你可以用自己的原话立题，逐字阅读各省的结论，并亲自裁定每一道关卡。该组只包含一个包 `sansheng`。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

一个包提供完整的三省制治理层；具体约定以该包 README 为准。

| 包 | 职责 |
|---|---|
| [`sansheng/`](sansheng/README.zh.md) | 让研究课题在起草、审核、执行三类 agent 间推进，批准权仅属人，记录封存，工具按角色门禁 |

<a id="related-documentation"></a>
## 相关文档

- [Subagent runtime](../subagent/subagent/README.zh.md) — 角色 agent 派生所经过的 activation API。
- [Subagent spawn provider](../subagent/subagent-spawn-in-process/README.zh.md) — 该层默认配置的进程内提供方。

<a id="dev-note"></a>
## 开发备注

无。
