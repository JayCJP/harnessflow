#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 Harness 7 Phase 流水线流程图的 .excalidraw 源文件。

设计论点：契约驱动、硬门控、AI 只机械执行的端到端开发流水线。
结构：横向时间线（Phase 0→6）+ 主流程 / 契约产出 / 控制流三层信息带 + 证据块。
配色严格取自 references/color-palette.md，不临时发明颜色。
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent / "diagrams" / "harness-flow.excalidraw"

# 调色板（来自 color-palette.md）
C = {
    "bg": "#FFFFFF", "stroke": "#1F2937", "text": "#111827",
    "text2": "#475467", "divider": "#D0D5DD",
    "neutral_fill": "#F8FAFC", "neutral_stroke": "#334155",
    "start_fill": "#ECFDF3", "start_stroke": "#027A48",
    "end_fill": "#EFF8FF", "end_stroke": "#175CD3",
    "decision_fill": "#FFF7ED", "decision_stroke": "#C4320A",
    "warn_fill": "#FEF3F2", "warn_stroke": "#D92D20",
    "ai_fill": "#F5F3FF", "ai_stroke": "#7A5AF8",
    "data_fill": "#F0F9FF", "data_stroke": "#026AA2",
    "evidence_bg": "#101828", "evidence_border": "#344054",
    "evidence_title": "#F8FAFC", "code_key": "#7DD3FC",
    "code_str": "#86EFAC", "code_comment": "#98A2B3",
}

_seq = 1000


def _common(eid, etype, x, y, w, h, stroke, fill, sw=2):
    """生成 Excalidraw 元素的公共字段（所有元素必需）。"""
    global _seq
    _seq += 1
    return {
        "id": eid, "type": etype, "x": x, "y": y, "width": w, "height": h,
        "strokeColor": stroke, "backgroundColor": fill, "fillStyle": "solid",
        "strokeWidth": sw, "strokeStyle": "solid", "roughness": 0,
        "opacity": 100, "angle": 0, "seed": _seq, "version": 1,
        "versionNonce": _seq + 5000, "isDeleted": False, "updated": 0,
        "link": None, "locked": False,
    }


def rect(eid, x, y, w, h, stroke, fill, sw=2):
    """矩形节点。"""
    e = _common(eid, "rectangle", x, y, w, h, stroke, fill, sw)
    e["boundElements"] = []
    return e


def ellipse(eid, x, y, w, h, stroke, fill, sw=2):
    """椭圆节点（起点/输入）。"""
    e = _common(eid, "ellipse", x, y, w, h, stroke, fill, sw)
    e["boundElements"] = []
    return e


def diamond(eid, x, y, w, h, stroke, fill, sw=2):
    """菱形决策节点。"""
    e = _common(eid, "diamond", x, y, w, h, stroke, fill, sw)
    e["boundElements"] = []
    return e


def text(eid, x, y, w, h, content, size, color, align="left", bold=False):
    """文字元素。content 中的 \\n 表示手动换行。"""
    global _seq
    _seq += 1
    return {
        "id": eid, "type": "text", "x": x, "y": y, "width": w, "height": h,
        "text": content, "originalText": content, "fontSize": size,
        "fontFamily": 3, "textAlign": align, "verticalAlign": "middle",
        "strokeColor": color, "backgroundColor": "transparent", "fillStyle": "solid",
        "strokeWidth": 1, "roughness": 0, "opacity": 100, "angle": 0,
        "seed": _seq, "version": 1, "versionNonce": _seq + 5000,
        "isDeleted": False, "updated": 0, "link": None, "locked": False,
        "containerId": None, "lineHeight": 1.25,
    }


def arrow(eid, points, color, sw=2, dashed=False, end_head="arrow"):
    """箭头。points 为相对坐标折线；折线可绕开内容区。"""
    x0 = points[0][0]
    y0 = points[0][1]
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    w = max(xs) - min(xs)
    h = max(ys) - min(ys)
    e = _common(eid, "arrow", x0, y0, w, h, color, "transparent", sw)
    e["boundElements"] = None
    e["points"] = [[p[0] - x0, p[1] - y0] for p in points]
    e["startBinding"] = None
    e["endBinding"] = None
    e["startArrowhead"] = None
    e["endArrowhead"] = end_head
    if dashed:
        e["strokeStyle"] = "dashed"
    return e


elements = []

# ── 标题区 ──────────────────────────────────────────────────────────
elements.append(text("title", 80, 40, 1100, 44,
                     "Harness 插件 · 7 Phase 端到端开发流水线", 30, C["text"]))
elements.append(text("subtitle", 80, 92, 1100, 30,
                     "契约驱动 · 硬门控 · AI 不操作状态，只机械执行（dispatch 只读调度 / advance-phase 唯一写入）",
                     15, C["text2"]))

# ── 主流程带 ────────────────────────────────────────────────────────
elements.append(text("band_main", 80, 142, 500, 24,
                     "主流程（Phase 0 → 6）", 15, C["stroke"]))

PHASES = [
    ("P0", "Phase 0", "需求分析", "需求分析师", C["ai_fill"], C["ai_stroke"]),
    ("P1", "Phase 1", "任务规划", "任务规划师", C["ai_fill"], C["ai_stroke"]),
    ("P2", "Phase 2", "代码开发", "前端开发工程师", C["neutral_fill"], C["neutral_stroke"]),
    ("P3", "Phase 3", "代码审查", "代码审查师", C["warn_fill"], C["warn_stroke"]),
    ("P4", "Phase 4", "知识库更新", "发布助手", C["end_fill"], C["end_stroke"]),
    ("P5", "Phase 5", "提交 + MR", "发布助手", C["end_fill"], C["end_stroke"]),
    ("P6", "Phase 6 可选", "云端部署", "发布助手", C["end_fill"], C["end_stroke"]),
]
CARD_W, CARD_H, CARD_Y, GAP, X0 = 210, 116, 178, 42, 80
card_x = {p[0]: X0 + i * (CARD_W + GAP) for i, p in enumerate(PHASES)}

for pid, num, name, agent, fill, stroke in PHASES:
    x = card_x[pid]
    elements.append(rect(f"card_{pid}", x, CARD_Y, CARD_W, CARD_H, stroke, fill, 2))
    elements.append(text(f"num_{pid}", x + 14, CARD_Y + 14, CARD_W - 28, 24,
                         num, 12, stroke))
    elements.append(text(f"name_{pid}", x + 14, CARD_Y + 40, CARD_W - 28, 34,
                         name, 19, C["text"]))
    elements.append(text(f"agent_{pid}", x + 14, CARD_Y + 80, CARD_W - 28, 24,
                         agent, 12, C["text2"]))

# 主流程箭头 + 门控标签
# 门控标签：极简短词，字号 9，放在卡片上沿之上（y-30），避免压到相邻卡片正文
GATE_LABELS = ["门控", "pass", "lint", "无BUG", "kb", "done"]
for i in range(6):
    p_from, p_to = PHASES[i][0], PHASES[i + 1][0]
    x1 = card_x[p_from] + CARD_W
    x2 = card_x[p_to]
    y = CARD_Y + CARD_H / 2
    elements.append(arrow(f"flow_{i}", [(x1, y), (x2, y)], C["text2"], 2))
    elements.append(text(f"gate_{i}", x1 - 6, y - 30, x2 - x1 + 12, 16,
                         GATE_LABELS[i], 9, C["decision_stroke"], "center"))

# ── 契约产出带 ──────────────────────────────────────────────────────
elements.append(text("band_artifact", 80, 336, 600, 24,
                     "关键产出物（真实契约文件 · 技术图证据）", 15, C["stroke"]))

ARTIFACTS = {
    "P0": "requirement-analysis.md\nacceptance-criteria.json\nopen-questions.json",
    "P1": "task-dag.json\n（并行任务 DAG）",
    "P2": "代码变更\ndev-pass 限时写保护",
    "P3": "code-review.json\nAC 逐条核对",
    "P4": "kb-update 增量文档\n（评审时点 git.hash）",
    "P5": "git-submit.json\ncommitHash / mrUrl",
    "P6": "dev 分支构建\n部署 URL",
}
for pid, art in ARTIFACTS.items():
    x = card_x[pid]
    elements.append(rect(f"art_{pid}", x, 368, CARD_W, 96,
                         C["divider"], C["data_fill"], 1))
    elements.append(text(f"art_text_{pid}", x + 12, 376, CARD_W - 24, 80,
                         art, 11, C["data_stroke"]))

# ── 控制流带 ────────────────────────────────────────────────────────
elements.append(text("band_control", 80, 492, 800, 24,
                     "控制流：dispatch 四态调度 + fix-loop 回退", 15, C["stroke"]))

# 用户起点
elements.append(ellipse("start_node", 80, 548, 150, 66, C["start_stroke"], C["start_fill"], 2))
elements.append(text("start_text", 96, 562, 118, 36, "/start\n命令", 15, C["start_stroke"], "center"))

# dispatch 菱形（决策）
DX, DY, DW, DH = 320, 530, 190, 100
elements.append(diamond("dispatch_node", DX, DY, DW, DH,
                        C["decision_stroke"], C["decision_fill"], 2))
elements.append(text("dispatch_text", DX + 28, DY + 32, DW - 56, 40,
                     "dispatch.js\n四态调度", 14, C["decision_stroke"], "center"))

elements.append(arrow("start_to_dispatch", [(230, 581), (DX, 581)], C["text2"], 2))

# 四态分支（右侧文字块，不用卡片包裹）
BRANCHES = [
    ("ready", "Spawn Agent / advance-phase", C["start_stroke"], 600),
    ("fix_loop", "回退 Phase 2 修复（≤2 轮）", C["warn_stroke"], 636),
    ("blocked", "转人工：用户确认 open-questions", C["decision_stroke"], 672),
    ("terminal", "归档 / end", C["end_stroke"], 708),
]
for key, desc, color, by in BRANCHES:
    elements.append(text(f"branch_{key}", 560, by, 150, 26, key, 14, color))
    elements.append(text(f"branch_desc_{key}", 720, by, 520, 26, desc, 13, C["text2"]))
    elements.append(arrow(f"branch_arrow_{key}",
                          [(DX + DW, 581), (540, 581), (540, by + 13), (560, by + 13)],
                          color, 1.5))

# fix-loop 回环：放在控制流右侧空白区做独立示意，不画穿透产出物带的长虚线
# （避免箭头穿过不该穿过的内容区 —— 这是 skill 明确禁止的布局问题）
FX = 1330
elements.append(text("fixloop_title", FX, 588, 360, 26,
                     "fix-loop 回退（BLOCKER / AC 未过）", 13, C["warn_stroke"]))
elements.append(rect("fix_p3", FX, 628, 120, 44,
                     C["warn_stroke"], C["warn_fill"], 2))
elements.append(text("fix_p3_text", FX + 12, 638, 96, 24, "P3 审查", 13, C["text"], "center"))
elements.append(rect("fix_p2", FX + 220, 628, 120, 44,
                     C["neutral_stroke"], C["neutral_fill"], 2))
elements.append(text("fix_p2_text", FX + 232, 638, 96, 24, "P2 修复", 13, C["text"], "center"))
# 回环箭头：P3 → 下方 → P2（在右侧空白区内折返，不穿其他带）
elements.append(arrow("fixloop_arc",
                      [(FX + 60, 672), (FX + 60, 716), (FX + 280, 716), (FX + 280, 672)],
                      C["warn_stroke"], 2, dashed=True))
elements.append(text("fixloop_desc", FX, 730, 360, 44,
                     "默认最多 2 轮，超出转人工", 12, C["text2"]))

# ── 证据块 ──────────────────────────────────────────────────────────
elements.append(rect("evidence_box", 80, 820, 980, 196,
                     C["evidence_border"], C["evidence_bg"], 1))
elements.append(text("evidence_title", 100, 834, 900, 24,
                     "核心机制（来自真实代码）", 14, C["evidence_title"]))
evidence_lines = [
    ("dispatch.js", "只读调度器，零写权限；status ∈ { ready, fix_loop, blocked, terminal }", C["code_key"]),
    ("advance-phase.js", "相位跃迁唯一执行者；判门控 / 写状态 / 签发·撤销 dev-pass", C["code_str"]),
    ("policy.js:checkPhase0Gate", "open-questions 放行只看 confirmation；AI 建议稿不构成放行依据", C["code_str"]),
    ("resolve-question.js", "用户答复经 --accept / --answer 落账 confirmation（AI 不得手填）", C["code_key"]),
]
for i, (k, v, col) in enumerate(evidence_lines):
    y = 866 + i * 34
    elements.append(text(f"ev_key_{i}", 100, y, 260, 28, k, 12, col))
    elements.append(text(f"ev_val_{i}", 370, y, 670, 28, v, 12, C["evidence_title"]))

# ── 图例 ────────────────────────────────────────────────────────────
elements.append(rect("legend_box", 1110, 820, 610, 196,
                     C["divider"], C["bg"], 1))
elements.append(text("legend_title", 1130, 834, 560, 24, "图例（颜色承担语义）", 14, C["text"]))
LEGEND = [
    (C["start_fill"], C["start_stroke"], "起点 / 输入（/start）"),
    (C["ai_fill"], C["ai_stroke"], "AI / Agent 推理阶段"),
    (C["neutral_fill"], C["neutral_stroke"], "普通执行阶段"),
    (C["warn_fill"], C["warn_stroke"], "风险 / 审查 / 回退"),
    (C["end_fill"], C["end_stroke"], "输出 / 结果 / 可选"),
    (C["decision_fill"], C["decision_stroke"], "决策 / 门控"),
]
for i, (fill, stroke, label) in enumerate(LEGEND):
    y = 868 + i * 24
    elements.append(rect(f"legend_sw_{i}", 1130, y, 20, 16, stroke, fill, 1))
    elements.append(text(f"legend_txt_{i}", 1162, y - 2, 540, 22, label, 12, C["text2"]))

doc = {
    "type": "excalidraw", "version": 2, "source": "https://excalidraw.com",
    "elements": elements,
    "appState": {"viewBackgroundColor": C["bg"], "gridSize": 20},
    "files": {},
}
OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"生成: {OUT}")
print(f"元素数: {len(elements)}")
