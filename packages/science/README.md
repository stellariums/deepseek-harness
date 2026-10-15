---
description: "The science package group: governance layers that run research workflows through separated agent roles with human-only approvals, for readers navigating the family."
kind: "package-group"
---

# science/ — governed research workflows

English | [中文](README.zh.md)

## Summary

The `science/` group holds governance layers for research work: a topic moves through role-separated agents — planner, reviewer, executor — coordinated by a relaying root session, while every approval and veto stays with the human. You can open a topic with your own words, read each agent's findings verbatim, and decide each gate yourself. The group contains one package, `sansheng`.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

One package provides the whole 三省制 governance layer; its README owns the contracts.

| Package | Role |
|---|---|
| [`sansheng/`](sansheng/README.md) | Runs a research topic through planner, reviewer, and executor agents with human-only approvals, sealed records, and a role-bound tool policy |

<a id="related-documentation"></a>
## Related documentation

- [Subagent runtime](../subagent/subagent/README.md) — the activation API the role agents spawn through.
- [Subagent spawn provider](../subagent/subagent-spawn-in-process/README.md) — the default in-process provider the layer configures.

<a id="dev-note"></a>
## Dev Note

None.
