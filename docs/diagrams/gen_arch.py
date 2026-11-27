#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 docs/assets/architecture.svg（tech-blue 主题）。

改布局改这里，重跑即可更新 SVG：
    python3 docs/diagrams/gen_arch.py
"""
import os
from xml.sax.saxutils import escape

CANVAS_W, CANVAS_H = 1320, 880

# ---------- theme (tech-blue) ----------
C = {
    "primary": ("#E8F0FE", "#5B8DEF"),
    "process": ("#D6E4F9", "#5B8DEF"),
    "accent":  ("#FFF0E5", "#E8A87C"),
    "neutral": ("#EDF2F7", "#A0AEC0"),
    "success": ("#E6F5EC", "#5BA87C"),
    "warning": ("#FFF8E1", "#D4A843"),
    "error":   ("#FDE8E8", "#D05050"),
    "secondary":("#EDE8F5", "#8B7EC4"),
    "storage": ("#E8F4F2", "#5BA8A0"),
    "group":   ("#F5F7FA", "#CBD5E0"),
}
TITLE_TXT = "#2D3748"
BODY_TXT = "#718096"
KEYWORD = "#4A7ADB"
ARROW = "#A0AEC0"
ANNOT = "#718096"

groups = [
    {"id": "g_front", "x": 40, "y": 84, "w": 1160, "h": 132, "label": "前端 Web 应用"},
    {"id": "g_gw",    "x": 40, "y": 256, "w": 1160, "h": 136, "label": "网关 Gateway（自研）"},
    {"id": "g_sbx",   "x": 40, "y": 432, "w": 1160, "h": 320,
     "label": "每用户沙箱 · Sandbox Runtime · E2B 协议兼容（自托管）"},
]

# node: id, x,y,w,h, role, title, subs[], shape(rr|cyl)
nodes = [
    {"id":"front_chat","x":110,"y":130,"w":420,"h":68,"role":"primary",
     "title":"对话面板","subs":["多轮 · 工具调用 · 权限批准 · 上传下载"]},
    {"id":"front_vnc","x":670,"y":130,"w":420,"h":68,"role":"primary",
     "title":"noVNC 浏览器画面","subs":["仅看 / 可接管"]},

    {"id":"gw_auth","x":95,"y":308,"w":235,"h":66,"role":"process",
     "title":"鉴权 & 路由","subs":["用户→沙箱 sticky"]},
    {"id":"gw_orch","x":360,"y":308,"w":235,"h":66,"role":"process",
     "title":"沙箱编排","subs":["E2B create/resume/pause"]},
    {"id":"gw_ws","x":625,"y":308,"w":235,"h":66,"role":"process",
     "title":"WS 事件代理","subs":["prompt · events"]},
    {"id":"gw_egress","x":890,"y":308,"w":235,"h":66,"role":"accent",
     "title":"模型出口代理","subs":["注入 Key · 计费"]},

    {"id":"sbx_rt","x":95,"y":500,"w":320,"h":96,"role":"accent",
     "title":"agent-runtime","subs":["OpenCode V2 SDK host","sessions · tools · events"]},
    {"id":"sbx_mcp","x":470,"y":512,"w":160,"h":72,"role":"process",
     "title":"browse mcp","subs":["stdio 代理"]},
    {"id":"sbx_relay","x":675,"y":512,"w":180,"h":72,"role":"process",
     "title":"browse relay","subs":["127.0.0.1:19988"]},
    {"id":"sbx_chr","x":905,"y":512,"w":210,"h":72,"role":"secondary",
     "title":"Chromium + extension","subs":["chrome.debugger"]},

    {"id":"sbx_persist","x":95,"y":638,"w":320,"h":92,"role":"storage","shape":"cyl",
     "title":"持久化 (Volume)","subs":["workspace · browser profile","opencode state"]},
]

# edge: id, source, target, points[], label, dashed, bidi, label_pos(optional)
edges = [
    {"id":"e_front_gw","s":"g_front","t":"g_gw","pts":[(620,216),(620,256)],
     "label":"HTTPS / WSS","dashed":False,"bidi":True},
    {"id":"e_gw_sbx","s":"g_gw","t":"g_sbx","pts":[(620,392),(620,432)],
     "label":"WS 转发 / E2B 编排","dashed":False,"bidi":False,
     "label_pos":(632,404,"start")},
    {"id":"e_rt_mcp","s":"sbx_rt","t":"sbx_mcp","pts":[(415,548),(470,548)],
     "label":"mcp","dashed":False,"bidi":False},
    {"id":"e_mcp_relay","s":"sbx_mcp","t":"sbx_relay","pts":[(630,548),(675,548)],
     "label":"","dashed":False,"bidi":False},
    {"id":"e_relay_chr","s":"sbx_relay","t":"sbx_chr","pts":[(855,548),(905,548)],
     "label":"WS / CDP","dashed":False,"bidi":False},
    {"id":"e_rt_persist","s":"sbx_rt","t":"sbx_persist","pts":[(255,596),(255,638)],
     "label":"","dashed":False,"bidi":False},
    {"id":"e_model","s":"sbx_rt","t":"gw_egress",
     "pts":[(255,500),(255,410),(1007,410),(1007,374)],
     "label":"模型请求 · Key 不进沙箱","dashed":True,"bidi":False,
     "label_pos":(792,426,"middle")},
    {"id":"e_vnc","s":"sbx_chr","t":"front_vnc",
     "pts":[(1115,548),(1255,548),(1255,164),(1090,164)],
     "label":"noVNC 流 (E2B)","dashed":True,"bidi":False},
]


def svg_text_lines(cx, cy, title, subs, title_size=15, sub_size=11):
    lines = [(title, title_size, TITLE_TXT, "700")]
    for s in subs:
        lines.append((s, sub_size, BODY_TXT, "400"))
    lh = 19
    total = len(lines) * lh
    y = cy - total/2 + lh*0.72
    out = []
    for txt, size, color, weight in lines:
        out.append(
            f'<text x="{cx}" y="{y:.1f}" text-anchor="middle" '
            f'font-size="{size}" fill="{color}" font-weight="{weight}">{escape(txt)}</text>'
        )
        y += lh
    return "\n".join(out)


def svg_node(n):
    fill, stroke = C[n["role"]]
    x, y, w, h = n["x"], n["y"], n["w"], n["h"]
    cx, cy = x + w/2, y + h/2
    out = []
    if n.get("shape") == "cyl":
        rx, ry = w/2, 12
        d = (f"M{x},{y+ry} a{rx},{ry} 0 0 1 {w},0 v{h-2*ry} "
             f"a{rx},{ry} 0 0 1 {-w},0 z")
        out.append(f'<path d="{d}" fill="{fill}" stroke="{stroke}" stroke-width="1.2"/>')
        out.append(f'<ellipse cx="{cx}" cy="{y+ry}" rx="{rx}" ry="{ry}" '
                   f'fill="none" stroke="{stroke}" stroke-width="1.2"/>')
        out.append(svg_text_lines(cx, cy + ry*0.6, n["title"], n["subs"]))
    else:
        out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" '
                   f'fill="{fill}" stroke="{stroke}" stroke-width="1.2"/>')
        out.append(svg_text_lines(cx, cy, n["title"], n["subs"]))
    return "\n".join(out)


def svg_group(g):
    fill, stroke = C["group"]
    out = [f'<rect x="{g["x"]}" y="{g["y"]}" width="{g["w"]}" height="{g["h"]}" rx="12" '
           f'fill="{fill}" fill-opacity="0.55" stroke="{stroke}" stroke-width="1.1" stroke-dasharray="6 4"/>']
    out.append(f'<text x="{g["x"]+16}" y="{g["y"]+24}" font-size="13" fill="{ANNOT}" '
               f'font-weight="700">{escape(g["label"])}</text>')
    return "\n".join(out)


def svg_edge(e):
    pts = e["pts"]
    d = "M " + " L ".join(f"{x},{y}" for x, y in pts)
    dash = ' stroke-dasharray="5 4"' if e["dashed"] else ""
    marker_end = ' marker-end="url(#arrow)"'
    marker_start = ' marker-start="url(#arrow)"' if e["bidi"] else ""
    out = [f'<path d="{d}" fill="none" stroke="{ARROW}" stroke-width="1.3"{dash}{marker_start}{marker_end}/>']
    if e["label"]:
        if e.get("label_pos"):
            lx, ly, anchor = e["label_pos"]
        else:
            best = max(range(len(pts)-1),
                       key=lambda i: abs(pts[i+1][0]-pts[i][0]) + abs(pts[i+1][1]-pts[i][1]))
            lx = (pts[best][0]+pts[best+1][0])/2
            ly = (pts[best][1]+pts[best+1][1])/2 - 6
            anchor = "middle"
        out.append(f'<text x="{lx:.1f}" y="{ly:.1f}" text-anchor="{anchor}" font-size="10.5" '
                   f'fill="{KEYWORD}">{escape(e["label"])}</text>')
    return "\n".join(out)


def build_svg():
    parts = []
    parts.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{CANVAS_W}" height="{CANVAS_H}" '
                 f'viewBox="0 0 {CANVAS_W} {CANVAS_H}" font-family="-apple-system, \'PingFang SC\', '
                 f'\'Microsoft YaHei\', \'Segoe UI\', sans-serif">')
    parts.append('<defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" '
                 'orient="auto" markerUnits="strokeWidth">'
                 f'<path d="M0,0 L7,3 L0,6 z" fill="{ARROW}"/></marker></defs>')
    parts.append(f'<rect x="0" y="0" width="{CANVAS_W}" height="{CANVAS_H}" fill="#FFFFFF"/>')
    parts.append(f'<text x="{CANVAS_W/2}" y="42" text-anchor="middle" font-size="24" '
                 f'font-weight="800" fill="{TITLE_TXT}">个人 Agent · 容器内架构</text>')
    parts.append(f'<text x="{CANVAS_W/2}" y="66" text-anchor="middle" font-size="12.5" '
                 f'fill="{BODY_TXT}">OpenCode 当大脑 · browse 当手 · Chromium 当眼 · 自托管沙箱提供隔离运行时</text>')
    for g in groups:
        parts.append(svg_group(g))
    for n in nodes:
        parts.append(svg_node(n))
    for e in edges:
        parts.append(svg_edge(e))
    parts.append(f'<text x="40" y="812" font-size="11.5" fill="{ANNOT}">'
                 f'handoff：卡片渲染在沙箱 Chromium 内，用户经 noVNC 真实点击 Continue 后 agent 继续。</text>')
    parts.append(f'<text x="40" y="834" font-size="11.5" fill="{ANNOT}">'
                 f'模型请求经网关出口代理注入凭证（Key 不进沙箱）；浏览器 profile 持久化以保证登录态不掉。</text>')
    parts.append('</svg>')
    return "\n".join(parts)


if __name__ == "__main__":
    base = os.path.dirname(os.path.abspath(__file__))       # docs/diagrams
    root = os.path.dirname(base)                            # docs
    assets = os.path.join(root, "assets")
    os.makedirs(assets, exist_ok=True)
    out = os.path.join(assets, "architecture.svg")
    with open(out, "w", encoding="utf-8") as f:
        f.write(build_svg())
    print("wrote:", out)
