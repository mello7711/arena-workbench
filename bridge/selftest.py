#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Arena MCP 自检 —— 一条命令查完 36 个工具。

用法：
    python selftest.py                # 全量自检
    python selftest.py --quick        # 只查关键项（约 10 秒）
    python selftest.py --json         # 机器可读输出

退出码：0 全通过 / 1 有失败项
"""
import argparse
import asyncio
import json
import os
import socket
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
LOGS = os.path.join(ROOT, "logs")
BRIDGE_PORT = 8768
MCP_PORTS = [8765, 8766, 8767, 8768]
FORCE_PORT = 0
REMOTE = False

R = []          # 结果收集
T0 = time.time()


LIVE = True


def rec(cat, name, ok, detail="", ms=0):
    R.append({"cat": cat, "name": name, "ok": bool(ok), "detail": str(detail)[:200], "ms": int(ms)})
    if LIVE:
        print(f"  {'OK  ' if ok else 'FAIL'} [{cat}] {name}: {str(detail)[:110]}", flush=True)


def port_open(port, host="127.0.0.1"):
    try:
        s = socket.create_connection((host, port), timeout=1.2)
        s.close()
        return True
    except Exception:
        return False


# ---------------- 1. 基础环境 ----------------
def check_env():
    t = time.time()
    ok = sys.version_info >= (3, 9)
    rec("环境", "Python 版本", ok, f"{sys.version.split()[0]}", (time.time() - t) * 1000)

    mods = ["mcp", "httpx", "httpcore", "websockets", "playwright", "pypdf", "docx",
            "openpyxl", "cryptography", "PIL", "mss", "pyautogui"]
    missing = []
    for m in mods:
        try:
            __import__(m)
        except Exception as e:
            missing.append(f"{m}({type(e).__name__})")
    rec("环境", "依赖完整性", not missing,
        "全部已安装" if not missing else "缺失: " + ", ".join(missing))

    venv = os.path.join(os.path.dirname(ROOT), ".venv", "pyvenv.cfg")
    rec("环境", "venv 完整", os.path.exists(venv),
        "pyvenv.cfg 存在" if os.path.exists(venv) else "缺 pyvenv.cfg（venv 被破坏，重启会起不来）")

    for f in ("desktop_mcp.py", "relay_pack.py", "svc_ctl.ps1", "sweep.ps1"):
        p = os.path.join(ROOT, f)
        rec("环境", f"文件 {f}", os.path.exists(p), f"{os.path.getsize(p)} B" if os.path.exists(p) else "缺失")


# ---------------- 2. 进程与服务 ----------------
def check_services():
    t = time.time()
    files = {"隧道": "tunnel.pid", "MCP本地": "mcp_local.pid", "MCP转发": "mcp.pid", "控制框": "controlbox.pid"}
    for label, fn in files.items():
        p = os.path.join(DATA, fn)
        if not os.path.exists(p):
            rec("服务", label, False, "pid 文件缺失")
            continue
        try:
            pid = open(p, encoding="utf-8").read().strip()
            out = os.popen(f'tasklist /FI "PID eq {pid}" /NH /FO CSV').read()
            alive = pid in out and "No tasks" not in out
            rec("服务", label, alive, f"PID={pid}" + ("" if alive else "（进程不在）"))
        except Exception as e:
            rec("服务", label, False, str(e))
    rec("服务", "MCP 端口监听", port_open(8765), "8765 " + ("LISTENING" if port_open(8765) else "不通"))
    rec("服务", "扩展桥端口", port_open(BRIDGE_PORT),
        "8768 " + ("LISTENING" if port_open(BRIDGE_PORT) else "不通（扩展未连接）"), (time.time() - t) * 1000)


# ---------------- 2.5 僵尸进程检测（事故 1/2 的哨兵）----------------
def check_zombie():
    """检测 MCP 进程存活但端口消失的僵尸态 —— 这是交互式命令卡死后留下的现场。"""
    t = time.time()
    p = os.path.join(DATA, "mcp_local.pid")
    if not os.path.exists(p):
        rec("僵尸", "MCP 进程健康", True, "无 pid 文件（未启动，跳过）")
        return
    try:
        pid = open(p, encoding="utf-8").read().strip()
    except Exception as e:
        rec("僵尸", "MCP 进程健康", False, str(e))
        return
    # 进程在不在
    out = os.popen(f'tasklist /FI "PID eq {pid}" /NH /FO CSV').read()
    alive = pid in out and "No tasks" not in out
    listening = port_open(8765)
    if not alive:
        rec("僵尸", "MCP 进程健康", False, f"PID={pid} 已不在，8765 " + ("在" if listening else "不在"))
        return
    if alive and not listening:
        # 关键判定：进程活着却不在监听 = 主循环已崩，只剩空壳
        mem = ""
        try:
            m = os.popen(f'wmic process where ProcessId={pid} get WorkingSetSize /value').read()
            for line in m.splitlines():
                if "WorkingSetSize" in line:
                    kb = int(line.split("=")[1].strip()) // 1024
                    mem = f" 内存仅 {kb} KB"
        except Exception:
            pass
        rec("僵尸", "MCP 进程健康", False,
            f"PID={pid} 活着但 8765 不监听{mem} → 主循环已崩（查 mcp.log.err 的 anyio.ClosedResourceError）")
        return
    rec("僵尸", "MCP 进程健康", True, f"PID={pid} 存活且 8765 在监听", (time.time() - t) * 1000)


def check_interactive_guard():
    """事故 1 的哨兵：检查日志里有没有交互式命令卡死留下的痕迹。"""
    log = os.path.join(LOGS, "mcp.log.err")
    if not os.path.exists(log):
        rec("僵尸", "无崩溃痕迹", True, "无 mcp.log.err")
        return
    try:
        tail = open(log, encoding="utf-8", errors="ignore").read()[-20000:]
    except Exception as e:
        rec("僵尸", "无崩溃痕迹", True, str(e))
        return
    bad = []
    if "ClosedResourceError" in tail:
        bad.append("ClosedResourceError")
    if "ExceptionGroup" in tail:
        bad.append("ExceptionGroup")
    if bad:
        rec("僵尸", "无崩溃痕迹", False,
            "日志尾部出现 " + "/".join(bad) + " → 曾因交互式命令或断流崩溃，见 txt 12.6")
    else:
        rec("僵尸", "无崩溃痕迹", True, "日志尾部正常")



# ---------------- 3. MCP 协议 ----------------
def _post(port, payload, timeout=25):
    import urllib.request
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/mcp",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read().decode())


def mcp_call(port, name, args, timeout=60):
    """调用一个工具。任何异常都转成 {ok:False,error:...}，绝不抛出去。"""
    try:
        _post(port, {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                     "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                "clientInfo": {"name": "selftest", "version": "1"}}}, timeout)
        d = _post(port, {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                         "params": {"name": name, "arguments": args}}, timeout)
    except Exception as e:
        return {"ok": False, "error": f"HTTP {type(e).__name__}: {e}"}
    try:
        return json.loads(d["result"]["content"][0]["text"])
    except Exception:
        return {"ok": False, "error": str(d)[:150]}


def check_protocol(quick=False):
    port = FORCE_PORT if FORCE_PORT else next((p for p in MCP_PORTS if port_open(p)), None)
    if port is None:
        rec("协议", "找到 MCP 端口", False, "8765-8768 全不通")
        return
    rec("协议", "找到 MCP 端口", True, f"端口 {port}")

    try:
        _post(port, {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                     "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                "clientInfo": {"name": "selftest", "version": "1"}}})
        d = _post(port, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        tools = [t["name"] for t in d["result"]["tools"]]
    except Exception as e:
        rec("协议", "tools/list", False, f"HTTP {type(e).__name__}: {str(e)[:120]}")
        return
    rec("协议", "工具数量", len(tools) == 36, f"{len(tools)} 个（期望 36）")

    expected = {"screenshot", "screen_size", "mouse_move", "mouse_click", "mouse_scroll",
                "keyboard_type", "keyboard_hotkey", "read_file", "list_dir", "search_text",
                "file_edit", "file_write", "file_publish", "exec_command", "read_image",
                "glob_files", "exec_bg", "bg_output", "bg_stop", "read_pdf", "read_docx",
                "read_xlsx", "web_fetch", "web_search", "browser_start", "browser_tabs",
                "browser_open", "browser_navigate", "browser_act", "browser_read",
                "browser_shot", "browser_group", "browser_close",
                "session_list", "session_read", "session_relay"}
    lost = expected - set(tools)
    rec("协议", "工具清单完整", not lost, "全部存在" if not lost else "缺: " + ", ".join(sorted(lost)))


# ---------------- 4. 工具冒烟 ----------------
def check_tools(quick=False):
    PORT_USED = FORCE_PORT if FORCE_PORT else next((p for p in MCP_PORTS if port_open(p)), 8765)
    if REMOTE:
        TESTROOT = os.environ.get("SELFTEST_ROOT", r"C:\Users\Public")
        tmp = TESTROOT + r"\arena_selftest.tmp"
    else:
        TESTROOT = os.path.dirname(ROOT)
        tmp = os.path.join(DATA, "selftest.tmp")
        os.makedirs(DATA, exist_ok=True)

    def go(name, args, ok_field="ok", note=""):
        t = time.time()
        try:
            r = mcp_call(PORT_USED, name, args)
            ok = bool(r.get(ok_field)) if ok_field else ("error" not in r)
            detail = r.get("error") or r.get(note or "note") or ""
            if not detail:
                keys = [k for k in ("count", "value", "path", "width", "mode", "url") if k in r]
                detail = ", ".join(f"{k}={str(r[k])[:40]}" for k in keys[:2])
            rec("工具", name, ok, detail, (time.time() - t) * 1000)
            return r
        except Exception as e:
            rec("工具", name, False, f"{type(e).__name__}: {e}", (time.time() - t) * 1000)
            return {}

    # 桌面
    r = go("screen_size", {}, ok_field=None)
    rec("工具", "screen_size 返回尺寸",
        all(k in r for k in ("width", "height")), f"{r.get('width')}x{r.get('height')}")

    # 文件
    go("list_dir", {"path": TESTROOT})
    go("glob_files", {"root": TESTROOT, "pattern": "*.*"})
    go("search_text", {"root": TESTROOT, "query": "a", "max_results": 3})

    # 写 / 改 / 读 / 删 闭环
    t = time.time()
    try:
        r1 = mcp_call(PORT_USED, "file_write", {"path": tmp, "content": "selftest-line-1\n"})
        r2 = mcp_call(PORT_USED, "file_edit", {"path": tmp, "old_string": "line-1", "new_string": "line-X"})
        r3 = mcp_call(PORT_USED, "read_file", {"path": tmp, "max_bytes": 200})
        content = r3.get("content", "")
        okall = r1.get("ok") and r2.get("ok") and "line-X" in content
        rec("工具", "file_write/edit/read 闭环", okall,
            "写入→替换→回读一致" if okall else f"write={r1.get('ok')} edit={r2.get('ok')} read={'line-X' in content}",
            (time.time() - t) * 1000)
        if not REMOTE:
            try: os.remove(tmp)
            except Exception: pass
        rec("工具", "临时文件清理", True, "已处理")
    except Exception as e:
        rec("工具", "file_write/edit/read 闭环", False, str(e))

    # 命令
    t = time.time()
    r = mcp_call(PORT_USED, "exec_command", {"shell": "powershell", "command": "echo SELFTEST-OK", "timeout_sec": 30})
    rec("工具", "exec_command", "SELFTEST-OK" in (r.get("stdout") or ""), f"exit={r.get('exit_code')}",
        (time.time() - t) * 1000)

    # 网络（这次新增的重点）
    go("web_fetch", {"url": "https://example.com", "max_bytes": 500}, note="status")
    go("web_search", {"query": "python", "max_results": 2})

    # 浏览器
    r = go("browser_start", {}, ok_field=None)
    mode = r.get("mode", "")
    if mode == "extension":
        r = go("browser_tabs", {})
        tabs = r.get("tabs") or []
        rec("工具", "browser_tabs 有标签页", len(tabs) > 0, f"{len(tabs)} 个")
        if tabs and not quick:
            live = next((t for t in tabs if t["url"].startswith(("http", "file"))), None)
            if live:
                i2 = live["index"]
                go("browser_read", {"tab_index": i2, "max_chars": 200})
                go("browser_act", {"tab_index": i2, "action": "version"})
                go("browser_act", {"tab_index": i2, "action": "eval", "selector": "1+1"})
            else:
                rec("工具", "browser_read/act", True, "无可用网页标签页，跳过（非故障）")
    else:
        rec("工具", "浏览器桥", False, f"未连扩展（mode={mode or 'unknown'}）")

    # 会话
    go("session_list", {"source": "all", "days": 7, "limit": 3})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--port", type=int, default=0, help="指定 MCP 端口（沙箱侧走隧道时用，如 18765）")
    a = ap.parse_args()

    global FORCE_PORT, REMOTE
    FORCE_PORT = a.port
    REMOTE = bool(a.port)          # 指定端口 = 从沙箱走隧道，本机检查无意义
    if REMOTE:
        rec("环境", "运行模式", True, f"远端模式（端口 {a.port}），跳过本机路径检查")
    else:
        check_env()
        check_services()
    check_zombie()
    check_interactive_guard()
    check_protocol(a.quick)
    check_tools(a.quick)

    fails = [x for x in R if not x["ok"]]
    if a.json:
        print(json.dumps({"total": len(R), "failed": len(fails), "results": R},
                         ensure_ascii=False, indent=2))
        return 1 if fails else 0

    print("=" * 66)
    print(f"Arena MCP 自检    {time.strftime('%Y-%m-%d %H:%M:%S')}    用时 {time.time()-T0:.1f}s")
    print("=" * 66)
    cur = None
    for x in R:
        if x["cat"] != cur:
            cur = x["cat"]
            print(f"\n【{cur}】")
        mark = "OK  " if x["ok"] else "FAIL"
        print(f"  {mark} {x['name']:26s} {x['detail']}")
    print("\n" + "=" * 66)
    if fails:
        print(f"结果：{len(R)-len(fails)} 通过 / {len(fails)} 失败")
        print("失败项：")
        for x in fails:
            print(f"  - {x['cat']}·{x['name']}: {x['detail']}")
    else:
        print(f"结果：全部 {len(R)} 项通过")
    print("=" * 66)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
