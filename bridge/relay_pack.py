# -*- coding: utf-8 -*-
"""会话接力包：把本地 AI 代理（agent）会话打包成可粘贴给 Arena 的交接文本。

本机有哪些 agent 由脚本自己探测——AGENTS 注册表逐个检查已知数据路径，
存在且非空才出现在结果里，换任何一台机器跑都不需要改代码。

CLI:
  relay_pack.py list [days] [limit]        -> JSON（agents: 探测到的来源；sessions: 会话列表）
  relay_pack.py pack <source> <key> [last] -> 纯文本接力包（stdout）

被 desktop_mcp.py 导入时提供同样的两个函数。
"""
import glob
import json
import os
import sqlite3
import sys
import time
from datetime import datetime

HOME = os.path.expanduser("~")
ZCODE_DB = os.path.join(HOME, ".zcode", "cli", "db", "db.sqlite")
CODEX_DIR = os.path.join(HOME, ".codex", "sessions")

TOOLS_GUIDE = (
    "【本地工具连接说明（全能 MCP，36 个工具）】\n"
    "  传输: streamable-http；端点(在VPS上): http://127.0.0.1:8765/mcp\n"
    "  文件/命令(6): read_file / list_dir / search_text / file_edit / file_publish / exec_command"
    "（全盘绝对路径、本机用户权限、任意 cwd）\n"
    "  扩展(11): read_image(看本地图片) / file_write / glob_files / exec_bg+bg_output+bg_stop(后台任务) /"
    " read_pdf / read_docx / read_xlsx / web_fetch / web_search(Bing,实验性)\n"
    "  浏览器(9): browser_start/tabs/open/navigate/act/read/shot/group/close（装了 extension/ 扩展=控制你的主浏览器含标签分组；否则用受管实例）\n"
    "  桌面(7): screenshot / screen_size / mouse_move / mouse_click / mouse_scroll / keyboard_type / keyboard_hotkey\n"
    "  会话接力(3): session_list / session_read / session_relay（读本地 agent 会话）\n"
    "  SSH 终端(可选): ssh local-windows \"whoami\"\n"
    "  先 tools/list 确认，再开始任务。"
)


def _iso(ms) -> str:
    try:
        return datetime.fromtimestamp(int(ms) / 1000).strftime("%m-%d %H:%M")
    except Exception:
        return "?"


# ---------------------------------------------------------------- ZCode ----

def zcode_probe() -> bool:
    return os.path.isfile(ZCODE_DB)


def _zcode_connect():
    con = sqlite3.connect(ZCODE_DB)
    con.row_factory = sqlite3.Row
    return con


def zcode_list(days: int, limit: int) -> list:
    cutoff = time.time() - max(int(days), 1) * 86400
    out = []
    con = _zcode_connect()
    rows = con.execute(
        "select id, title, directory, time_updated, task_type from session "
        "where time_deleted is null and (task_type is null or task_type != 'fork') "
        "order by time_updated desc limit 200"
    ).fetchall()
    for r in rows:
        ts = int(r["time_updated"]) / 1000
        if ts < cutoff:
            continue
        out.append({
            "source": "zcode",
            "key": r["id"],
            "label": f"[ZCode] {r['title']} · {_iso(r['time_updated'])} · {os.path.basename(r['directory'] or '')}",
            "title": r["title"],
            "directory": r["directory"] or "",
            "updated": _iso(r["time_updated"]),
        })
    con.close()
    return out[: max(int(limit), 1)]


def zcode_messages(session_id: str, last_messages: int) -> tuple:
    con = _zcode_connect()
    sess = con.execute("select * from session where id=?", (session_id,)).fetchone()
    msgs = []
    rows = con.execute(
        "select m.data, p.data from message m join part p on p.message_id = m.id "
        "where m.session_id=? order by m.sequence, p.sequence", (session_id,)
    ).fetchall()
    by_msg = {}
    for r in rows:
        try:
            part = json.loads(r["p.data"] if "p.data" in r.keys() else r[1])
        except Exception:
            continue
        if part.get("type") != "text":
            continue
        try:
            m = json.loads(r["m.data"] if "m.data" in r.keys() else r[0])
        except Exception:
            continue
        by_msg.setdefault(m.get("role", "?"), [])
        by_msg[m["role"]].append(part.get("text", ""))
    for role, texts in by_msg.items():
        txt = "\n".join(t for t in texts if t and t.strip())
        if txt.strip():
            msgs.append((role, txt.strip()))
    todos = []
    if sess:
        try:
            for t in con.execute("select content,status,priority from todo where session_id=? order by position", (session_id,)):
                todos.append(f"[{t['status']}] {t['content']}")
        except Exception:
            pass
    con.close()
    if not sess:
        return None, [], []
    return dict(sess), msgs[-max(int(last_messages), 1):], todos


# ---------------------------------------------------------- Codex (jsonl) ----

def codex_probe() -> bool:
    return os.path.isdir(CODEX_DIR) and bool(glob.glob(os.path.join(CODEX_DIR, "*", "*", "*", "rollout-*.jsonl")))


def codex_list(days: int, limit: int) -> list:
    out = []
    files = glob.glob(os.path.join(CODEX_DIR, "*", "*", "*", "rollout-*.jsonl"))
    files = [(f, os.path.getmtime(f)) for f in files]
    files.sort(key=lambda x: x[1], reverse=True)
    for f, mt in files[:80]:
        cwd, title, n_msgs = "", "", 0
        try:
            with open(f, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    if d.get("type") == "session_meta":
                        cwd = d.get("payload", {}).get("cwd", cwd)
                        continue
                    p = d.get("payload", {})
                    if d.get("type") == "response_item" and p.get("type") == "message" and p.get("role") in ("user", "assistant"):
                        n_msgs += 1
                        if p.get("role") == "user" and not title:
                            txt = "".join(c.get("text", "") for c in p.get("content", []) if isinstance(c, dict)).strip()
                            if txt and not txt.startswith(("<codex_apps", "<environment_context", "<turn_aborted")):
                                title = " ".join(txt.split())[:80]
                title = title or os.path.basename(f)[:60]
        except Exception as e:
            title = f"读取失败: {e}"
        out.append({
            "source": "codex",
            "key": f,
            "label": f"[Codex] {title} · {time.strftime('%m-%d %H:%M', time.localtime(mt))} · {os.path.basename(cwd) if cwd else '?'}",
            "title": title,
            "directory": cwd,
            "updated": time.strftime("%m-%d %H:%M", time.localtime(mt)),
            "messages": n_msgs,
        })
    out.sort(key=lambda x: x.get("updated") or "", reverse=True)
    return out[: max(int(limit), 1)]


def codex_messages(path: str, last_messages: int) -> tuple:
    msgs, cwd = [], ""
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("type") == "session_meta":
                cwd = d.get("payload", {}).get("cwd", cwd)
                continue
            p = d.get("payload", {})
            if d.get("type") == "response_item" and p.get("type") == "message" and p.get("role") in ("user", "assistant"):
                txt = "".join(c.get("text", "") for c in p.get("content", []) if isinstance(c, dict)).strip()
                if not txt or txt.startswith(("<codex_apps", "<environment_context", "<turn_aborted")):
                    continue
                msgs.append((p["role"], txt))
    return cwd, msgs[-max(int(last_messages), 1):]


# ------------------------------------- Claude 家族（projects/*.jsonl） ----
# Claude Code 与其衍生（WorkBuddy/CodeBuddy 桌面端）共用同一布局：
#   <root>/projects/<编码后的工作目录>/<会话id>.jsonl
# 行结构兼容两种：{"type":"user"|"assistant","message":{role,content[]}}
# 和 {"type":"message","role":...,"content":[...]}。

def _claude_family_roots(agent_id: str) -> list:
    if agent_id == "claude":
        return [os.path.join(HOME, ".claude", "projects")]
    if agent_id == "workbuddy":
        return [os.path.join(HOME, ".workbuddy", "projects"), os.path.join(HOME, ".workbuddy-ai", "projects")]
    return []


def _claude_family_files(roots: list) -> list:
    files = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for f in glob.glob(os.path.join(root, "*", "*.jsonl")):
            files.append(f)
    files = [(f, os.path.getmtime(f)) for f in files]
    files.sort(key=lambda x: x[1], reverse=True)
    return files


def _claude_family_probe(agent_id: str) -> bool:
    return bool(_claude_family_files(_claude_family_roots(agent_id)))


def _claude_family_list(agent_id: str, display: str, days: int, limit: int) -> list:
    cutoff = time.time() - max(int(days), 1) * 86400
    out = []
    for f, mt in _claude_family_files(_claude_family_roots(agent_id))[:80]:
        if mt < cutoff:
            continue
        cwd, title, n_msgs = "", "", 0
        try:
            with open(f, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    cwd = d.get("cwd") or cwd
                    t = d.get("type")
                    if t in ("user", "assistant"):
                        m = d.get("message") or {}
                        role = m.get("role") or t
                        parts = m.get("content")
                    elif t == "message":
                        role = d.get("role", "?")
                        parts = d.get("content")
                    else:
                        continue
                    if not isinstance(parts, list):
                        continue
                    txt = " ".join(p.get("text", "") for p in parts if isinstance(p, dict) and p.get("text", "").strip()).strip()
                    if not txt or txt.startswith(("<system-reminder", "<command-", "<local-command")):
                        continue
                    n_msgs += 1
                    if role == "user" and not title:
                        title = " ".join(txt.split())[:80]
            title = title or os.path.basename(f)[:60]
        except Exception as e:
            title = f"读取失败: {e}"
        out.append({
            "source": agent_id,
            "key": f,
            "label": f"[{display}] {title} · {time.strftime('%m-%d %H:%M', time.localtime(mt))} · {os.path.basename(cwd) if cwd else '?'}",
            "title": title,
            "directory": cwd,
            "updated": time.strftime("%m-%d %H:%M", time.localtime(mt)),
            "messages": n_msgs,
        })
    out.sort(key=lambda x: x.get("updated") or "", reverse=True)
    return out[: max(int(limit), 1)]


def _claude_family_messages(path: str, last_messages: int) -> list:
    msgs = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except Exception:
                continue
            t = d.get("type")
            if t in ("user", "assistant"):
                m = d.get("message") or {}
                role = m.get("role") or t
                parts = m.get("content")
            elif t == "message":
                role = d.get("role", "?")
                parts = d.get("content")
            else:
                continue
            if not isinstance(parts, list):
                continue
            txt = "\n".join(p.get("text", "") for p in parts if isinstance(p, dict) and p.get("type") in ("text", "input_text") and p.get("text", "").strip()).strip()
            if not txt or txt.startswith(("<system-reminder", "<command-", "<local-command")):
                continue
            msgs.append((role, txt))
    return msgs[-max(int(last_messages), 1):]


# ------------------------------------------------------------- 注册表 ----
# 每个来源一段自描述；list 只报告探测到数据的那些，脚本换机器不用改。

AGENTS = [
    {"id": "zcode", "name": "ZCode", "probe": zcode_probe, "list": zcode_list},
    {"id": "codex", "name": "Codex", "probe": codex_probe, "list": codex_list},
    {"id": "claude", "name": "Claude Code", "probe": lambda: _claude_family_probe("claude"), "list": lambda days, limit: _claude_family_list("claude", "Claude", days, limit)},
    {"id": "workbuddy", "name": "WorkBuddy", "probe": lambda: _claude_family_probe("workbuddy"), "list": lambda days, limit: _claude_family_list("workbuddy", "WorkBuddy", days, limit)},
]

PACKERS = {
    "zcode": lambda key, last: (lambda s, m, t: (s, m, t))(*zcode_messages(key, last)),
    "codex": lambda key, last: (lambda c, m: ({"title": os.path.basename(key)[:60], "directory": c}, m, []))(*codex_messages(key, last)),
    "claude": lambda key, last: ({"title": os.path.basename(key)[:60], "directory": ""}, _claude_family_messages(key, last), []),
    "workbuddy": lambda key, last: ({"title": os.path.basename(key)[:60], "directory": ""}, _claude_family_messages(key, last), []),
}


def detect_agents() -> list:
    found = []
    for a in AGENTS:
        try:
            if a["probe"]():
                found.append({"id": a["id"], "name": a["name"]})
        except Exception:
            continue
    return found


def list_sessions(source: str = "all", days: int = 14, limit: int = 25) -> list:
    # 每个来源各自吃满 limit——全局截断会让最老的来源永远垫底被截。
    out = []
    for a in AGENTS:
        if source not in ("all", a["id"]):
            continue
        try:
            if source == "all" and not a["probe"]():
                continue
            out.extend(a["list"](days, limit))
        except Exception as e:
            out.append({"source": a["id"], "key": "", "label": f"[{a['name']}] 读取失败: {e}", "title": "", "directory": "", "updated": ""})
    out.sort(key=lambda x: x.get("updated") or "", reverse=True)
    return out


# --------------------------------------------------------------- 打包 ----

def _clip(s: str, n: int) -> str:
    return s if len(s) <= n else s[:n] + f"…(截断，全文见源会话)"


def build_package(source: str, key: str, last_messages: int = 30, per_message_chars: int = 800, extra_note: str = "") -> str:
    src = (source or "").lower()
    packer = PACKERS.get(src)
    if not packer:
        return f"未知来源: {source}（本机探测到: {', '.join(a['id'] for a in detect_agents()) or '无'}）"
    sess, msgs, todos = packer(key, last_messages)
    lines = ["# 会话接力包（上一个 AI 代理的工作现场）", ""]
    if sess is None:
        return f"未找到 {src} 会话: {key}"
    if src == "zcode":
        lines += [f"- 来源: ZCode 会话 {key}",
                  f"- 标题: {sess['title']}",
                  f"- 工作目录: {sess['directory']}",
                  f"- 最后活动: {_iso(sess['time_updated'])}", ""]
    else:
        lines += [f"- 来源: {dict((a['id'], a['name']) for a in AGENTS).get(src, src)} 会话",
                  f"- 会话文件: {key}",
                  f"- 工作目录: {sess.get('directory', '')}", ""]
    if todos:
        lines += ["## 待办清单", *[f"- {t}" for t in todos], ""]
    if extra_note.strip():
        lines += ["## 补充说明", extra_note.strip(), ""]
    lines.append("## 近期对话（用户/助手，节选）")
    for role, txt in msgs:
        who = "用户" if role == "user" else "助手"
        lines.append(f"\n[{who}] {_clip(' '.join(txt.split()), per_message_chars)}")
    lines += ["", "## 你要做的", TOOLS_GUIDE, "",
              "请先用 MCP 的 list_dir/read_file 查看工作目录了解现状，再按上方对话与待办继续完成任务；"
              "重要改动先备份，完成后汇报结果。未执行的步骤明确说明。"]
    return "\n".join(lines)


def main(argv):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    if len(argv) >= 1 and argv[0] == "list":
        days = int(argv[1]) if len(argv) > 1 else 14
        limit = int(argv[2]) if len(argv) > 2 else 25
        print(json.dumps({"agents": detect_agents(), "sessions": list_sessions("all", days, limit)}, ensure_ascii=False))
    elif len(argv) >= 3 and argv[0] == "pack":
        last = int(argv[3]) if len(argv) > 3 else 30
        print(build_package(argv[1], argv[2], last))
    else:
        print("usage: relay_pack.py list [days] [limit] | pack <source> <key> [last]", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main(sys.argv[1:])
