"""
Arena Desktop MCP Server — 全能本地工具（手 + 眼睛）
通过 SSH 隧道暴露为 streamable-http，供云端 Arena 调用。

桌面工具（眼睛/手）：
  screenshot()                     -> 截取全屏，返回 JPEG base64（宽<=1280，q75，比 PNG 省 ~70% 体积）
  mouse_move(x, y)                 -> 移动鼠标到绝对坐标
  mouse_click(x, y, button)        -> 点击指定坐标
  mouse_scroll(clicks)             -> 滚动
  keyboard_type(text)              -> 输入文本
  keyboard_hotkey(keys...)         -> 组合键，如 keyboard_hotkey("ctrl","c")
  screen_size()                    -> 屏幕分辨率

文件/命令工具（手，全盘绝对路径、本机用户全权限、任意 cwd）：
  read_file(path, offset_line, max_bytes)   -> 读文本
  list_dir(path)                            -> 列目录
  search_text(root, query, ...)             -> 递归搜索
  file_edit(path, old_string, new_string)   -> 原子替换
  file_publish(path, content_base64)        -> 写入文件（自动建目录）
  exec_command(command, cwd, timeout_sec)   -> 执行命令

会话接力工具（读取本地 ZCode / Codex 会话，用于断点接力）：
  session_list(source, days, limit)         -> 列出近期会话
  session_read(source, key, last_messages)  -> 读取会话近期对话与待办
  session_relay(source, key, ...)           -> 生成完整接力包文本
"""
from contextlib import asynccontextmanager
import asyncio
import base64
import datetime
import fnmatch
import functools
import inspect
import io
import json
import os
import re
import socket
import subprocess
import tempfile
import threading
import time

import mss
import pyautogui
from PIL import Image

from mcp.server.fastmcp import FastMCP

# 安全边界：鼠标默认别乱飘
pyautogui.PAUSE = 0.05
pyautogui.FAILSAFE = True

PORT = int(os.environ.get("ARENA_DESKTOP_MCP_PORT", "8765"))


@asynccontextmanager
async def _lifespan(app):
    """MCP 一启动就拉起扩展桥监听（8768），扩展徽标无需等到首次调用才变 ON。"""
    try:
        await _ensure_bridge()
    except Exception:
        pass
    yield


server = FastMCP("arena-desktop", host="127.0.0.1", port=PORT, stateless_http=True, json_response=True, lifespan=_lifespan)

# 递归搜索时默认跳过的目录名（可用 skip_ignores=False 关闭）
SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".venv", "venv", "site-packages", "$RECYCLE.BIN", "System Volume Information"}


def _screenshot_img(max_width: int = 1280) -> Image.Image:
    with mss.mss() as sct:
        shot = sct.grab(sct.monitors[0])  # 全屏
        # shot.rgb = (height,width,3) 的 bytes，直接交给 PIL
        im = Image.frombytes("RGB", shot.size, shot.rgb)
    # 压缩到宽<=1280，避免回传过大
    if im.width > max_width:
        ratio = max_width / im.width
        im = im.resize((max_width, int(im.height * ratio)))
    return im


def _screenshot_jpeg(quality: int = 75) -> bytes:
    buf = io.BytesIO()
    _screenshot_img().save(buf, "JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def _img_to_jpeg_b64(png_b64: str, quality: int = 75) -> str:
    """把浏览器侧返回的 PNG base64 转成 JPEG base64，减少过隧道回传的体积。"""
    try:
        im = Image.open(io.BytesIO(base64.b64decode(png_b64)))
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        if im.width > 1280:
            ratio = 1280 / im.width
            im = im.resize((1280, int(im.height * ratio)))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=quality, optimize=True)
        return base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return png_b64


def _decode(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("gbk", errors="replace")


def _abs(path: str) -> str:
    p = os.path.abspath(os.path.expanduser(str(path or "").strip()))
    if not os.path.isabs(p):
        raise ValueError(f"需要绝对路径，收到: {path!r}")
    return p


def _atomic_write_bytes(p: str, data: bytes, append: bool = False) -> None:
    os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
    if append:
        with open(p, "ab") as f:
            f.write(data)
        return
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p) or ".", prefix=".mcp-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


# ---------------- 治理层：事件上报 / 暂停开关 / 审计日志 ----------------

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIT_PATH = os.path.join(_ROOT, "logs", "audit.jsonl")
PAUSE_FLAG = os.path.join(_ROOT, "data", "paused.flag")
BOX_PORT = 8767


def _paused() -> bool:
    return os.path.exists(PAUSE_FLAG)


def _notify(event: dict) -> None:
    event["ts"] = time.strftime("%H:%M:%S")
    try:
        os.makedirs(os.path.dirname(AUDIT_PATH), exist_ok=True)
        with open(AUDIT_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
    except Exception:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.2)
        s.sendto(json.dumps(event, ensure_ascii=False).encode("utf-8"), ("127.0.0.1", BOX_PORT))
        s.close()
    except Exception:
        pass


def watched(fn):
    """治理装饰器：暂停检查 → 上报开始 → 执行 → 上报结果。全部工具自动套用。"""
    name = fn.__name__
    sig = inspect.signature(fn)

    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        if _paused():
            return json.dumps({"ok": False, "paused": True,
                               "error": "本机用户已在控制框暂停 MCP；请在桌面右下角「Arena 本地控制」框点「恢复响应」"},
                              ensure_ascii=False)
        try:
            bound = sig.bind(*args, **kwargs)
            preview = json.dumps({k: str(v)[:70] for k, v in bound.arguments.items()}, ensure_ascii=False)[:180]
        except Exception:
            preview = ""
        _notify({"t": "start", "tool": name, "args": preview})
        t0 = time.time()
        ok = True
        try:
            result = await fn(*args, **kwargs)
            try:
                ok = bool(json.loads(result).get("ok", True))
            except Exception:
                ok = True
            return result
        except Exception as e:
            ok = False
            return json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)
        finally:
            _notify({"t": "done", "tool": name, "ok": ok, "ms": int((time.time() - t0) * 1000)})
    return wrapper


# ---------------- 桌面工具 ----------------

@server.tool()
@watched
async def screenshot() -> str:
    """截取当前全屏，返回 JPEG 的 base64（img_base64 字段，宽不超过1280，体积比 PNG 小很多，适合过隧道回传）。"""
    data = _screenshot_jpeg()
    return json.dumps({"img_base64": base64.b64encode(data).decode(), "format": "jpeg", "w": 1280, "h": None})


@server.tool()
@watched
async def screen_size() -> str:
    """返回屏幕分辨率。"""
    w, h = pyautogui.size()
    return json.dumps({"width": int(w), "height": int(h)})


@server.tool()
@watched
async def mouse_move(x: int, y: int) -> str:
    """移动鼠标到绝对坐标 (x, y)。"""
    pyautogui.moveTo(x, y)
    return json.dumps({"ok": True, "x": x, "y": y})


@server.tool()
@watched
async def mouse_click(x: int, y: int, button: str = "left") -> str:
    """点击绝对坐标 (x, y)。button: left/right/middle"""
    pyautogui.click(x, y, button=button)
    return json.dumps({"ok": True, "x": x, "y": y, "button": button})


@server.tool()
@watched
async def mouse_scroll(clicks: int) -> str:
    """滚动鼠标滚轮，正数向上负数向下。"""
    pyautogui.scroll(clicks)
    return json.dumps({"ok": True, "clicks": clicks})


@server.tool()
@watched
async def keyboard_type(text: str) -> str:
    """在当前焦点输入文本。"""
    pyautogui.typewrite(text, interval=0.01)
    return json.dumps({"ok": True, "chars": len(text)})


@server.tool()
@watched
async def keyboard_hotkey(keys: list[str]) -> str:
    """按下组合键，如 ['ctrl','c']。"""
    pyautogui.hotkey(*keys)
    return json.dumps({"ok": True, "keys": keys})


# ---------------- 文件/命令工具 ----------------

@server.tool()
@watched
async def read_file(path: str, offset_line: int = 0, max_bytes: int = 262144) -> str:
    """读取文件文本内容。path 绝对路径；offset_line 起始行（0 基）；max_bytes 内容字节上限。"""
    try:
        p = _abs(path)
        if not os.path.isfile(p):
            return json.dumps({"ok": False, "error": f"不是文件: {p}"})
        size = os.path.getsize(p)
        with open(p, "rb") as f:
            data = f.read(8 * 1024 * 1024)
        text = _decode(data)
        total_lines = text.count("\n") + (0 if text.endswith("\n") or not text else 1)
        lines = text.splitlines()
        if offset_line > 0:
            lines = lines[offset_line:]
        out = "\n".join(lines)
        truncated = False
        if len(out.encode("utf-8")) > max_bytes:
            out = out.encode("utf-8")[:max_bytes].decode("utf-8", errors="ignore")
            truncated = True
        return json.dumps({"ok": True, "path": p, "size": size, "total_lines": total_lines,
                           "offset_line": max(offset_line, 0), "truncated": truncated, "content": out})
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def list_dir(path: str) -> str:
    """列出目录内容（含隐藏项），最多 2000 项。"""
    try:
        p = _abs(path)
        if not os.path.isdir(p):
            return json.dumps({"ok": False, "error": f"不是目录: {p}"})
        entries = []
        for name in sorted(os.listdir(p), key=str.lower)[:2000]:
            fp = os.path.join(p, name)
            try:
                st = os.stat(fp, follow_symlinks=False)
                kind = "dir" if os.path.isdir(fp) else ("symlink" if os.path.islink(fp) else "file")
                entries.append({"name": name, "type": kind,
                                "size": None if kind == "dir" else st.st_size,
                                "mtime": datetime.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")})
            except OSError as oe:
                entries.append({"name": name, "type": "error", "error": str(oe)})
        return json.dumps({"ok": True, "path": p, "count": len(entries), "entries": entries})
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def search_text(root: str, query: str, is_regex: bool = False, glob: str = "",
                      case_sensitive: bool = False, max_results: int = 200,
                      skip_ignores: bool = True) -> str:
    """在 root 目录递归搜索文本。query 为文本或正则（is_regex）；glob 按文件名过滤如 *.py；返回 file:line:text。"""
    try:
        base = _abs(root)
        if not os.path.isdir(base):
            return json.dumps({"ok": False, "error": f"不是目录: {base}"})
        flags = 0 if case_sensitive else re.IGNORECASE
        pattern = re.compile(query if is_regex else re.escape(query), flags)
        hits, scanned, skipped = [], 0, 0
        for dirpath, dirnames, filenames in os.walk(base):
            if skip_ignores:
                dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for name in filenames:
                if glob and not fnmatch.fnmatch(name, glob):
                    continue
                fp = os.path.join(dirpath, name)
                try:
                    if os.path.getsize(fp) > 2 * 1024 * 1024:
                        skipped += 1
                        continue
                    scanned += 1
                    with open(fp, "rb") as f:
                        text = _decode(f.read(2 * 1024 * 1024))
                except OSError:
                    continue
                for i, line in enumerate(text.splitlines(), 1):
                    if pattern.search(line):
                        hits.append({"file": fp, "line": i, "text": line.strip()[:200]})
                        if len(hits) >= max(1, max_results):
                            return json.dumps({"ok": True, "root": base, "hits": hits,
                                               "truncated": True, "files_scanned": scanned, "files_skipped": skipped})
        return json.dumps({"ok": True, "root": base, "hits": hits, "truncated": False,
                           "files_scanned": scanned, "files_skipped": skipped})
    except re.error as e:
        return json.dumps({"ok": False, "error": f"正则无效: {e}"})
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def file_edit(path: str, old_string: str, new_string: str, expected_count: int = 0) -> str:
    """把文件中的 old_string 替换为 new_string（原子写入，保持原编码）。expected_count>0 时校验出现次数。"""
    try:
        p = _abs(path)
        if not os.path.isfile(p):
            return json.dumps({"ok": False, "error": f"不是文件: {p}"})
        raw = open(p, "rb").read()
        encoding = None
        for enc in ("utf-8", "gbk"):
            try:
                text = raw.decode(enc)
                encoding = enc
                break
            except UnicodeDecodeError:
                continue
        if encoding is None:
            return json.dumps({"ok": False, "error": "二进制或未知编码文件，拒绝编辑"})
        count = text.count(old_string)
        if count == 0:
            return json.dumps({"ok": False, "error": "old_string 未出现在文件中"})
        if expected_count > 0 and count != expected_count:
            return json.dumps({"ok": False, "error": f"出现 {count} 次，与 expected_count={expected_count} 不符"})
        new_text = text.replace(old_string, new_string)
        _atomic_write_bytes(p, new_text.encode(encoding))
        return json.dumps({"ok": True, "path": p, "replaced": count, "encoding": encoding})
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def file_publish(path: str, content_base64: str, append: bool = False) -> str:
    """把 base64 内容写入本地文件（自动建目录、原子覆盖；append=True 追加）。适合传二进制。"""
    try:
        p = _abs(path)
        data = base64.b64decode(str(content_base64), validate=True)
        _atomic_write_bytes(p, data, append=append)
        return json.dumps({"ok": True, "path": p, "bytes": len(data), "append": append})
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def exec_command(command: str, cwd: str = "", timeout_sec: int = 120, shell: str = "cmd") -> str:
    """以本机用户全权限执行命令。shell: cmd（默认）或 powershell；cwd 可选工作目录；返回 exit_code/stdout/stderr。"""
    try:
        workdir = _abs(cwd) if str(cwd or "").strip() else None
        if workdir and not os.path.isdir(workdir):
            return json.dumps({"ok": False, "error": f"工作目录不存在: {workdir}"})
        timeout_sec = min(max(int(timeout_sec), 1), 600)
        if shell == "powershell":
            argv = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]
            run = subprocess.run(argv, cwd=workdir, capture_output=True, timeout=timeout_sec)
        else:
            run = subprocess.run(command, shell=True, cwd=workdir, capture_output=True, timeout=timeout_sec)
        return json.dumps({"ok": run.returncode == 0, "exit_code": run.returncode, "shell": shell,
                           "cwd": workdir or os.getcwd(),
                           "stdout": _decode(run.stdout), "stderr": _decode(run.stderr)})
    except subprocess.TimeoutExpired as te:
        return json.dumps({"ok": False, "timeout": True, "timeout_sec": timeout_sec,
                           "stdout": _decode(te.stdout or b""), "stderr": _decode(te.stderr or b"")})
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


# ---------------- 扩展工具（图片 / 写入 / 查找 / 后台任务 / 文档 / 网络） ----------------

@server.tool()
@watched
async def read_image(path: str, max_width: int = 1280) -> str:
    """读取本地图片，返回 PNG base64（宽超过 max_width 等比缩小），供模型直接查看。"""
    try:
        p = _abs(path)
        im = Image.open(p)
        im.load()
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        if im.width > max(64, int(max_width)):
            ratio = max_width / im.width
            im = im.resize((int(max_width), max(1, int(im.height * ratio))))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=75, optimize=True)
        return json.dumps({"ok": True, "path": p, "w": im.width, "h": im.height,
                           "img_base64": base64.b64encode(buf.getvalue()).decode(), "format": "jpeg"})
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def file_write(path: str, content: str, append: bool = False) -> str:
    """把文本写入本地文件（utf-8，自动建目录；append=True 追加，否则原子覆盖）。"""
    try:
        p = _abs(path)
        _atomic_write_bytes(p, content.encode("utf-8"), append=append)
        return json.dumps({"ok": True, "path": p, "chars": len(content), "append": append})
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def glob_files(root: str, pattern: str, recursive: bool = True, limit: int = 500) -> str:
    """按通配符查找文件，如 *.py、**/*.md（recursive=True 递归）。返回绝对路径列表。"""
    try:
        import pathlib
        base = pathlib.Path(_abs(root))
        if not base.is_dir():
            return json.dumps({"ok": False, "error": f"不是目录: {base}"})
        pat = (pattern or "*").strip()
        it = base.rglob(pat) if recursive else base.glob(pat)
        hits = []
        for p in it:
            if len(hits) >= max(1, int(limit)):
                break
            if p.is_file():
                hits.append(str(p))
        return json.dumps({"ok": True, "root": str(base), "pattern": pat, "count": len(hits), "files": hits})
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


_BG = {}
_BG_SEQ = [0]


def _bg_logdir() -> str:
    d = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "bg")
    os.makedirs(d, exist_ok=True)
    return d


@server.tool()
@watched
async def exec_bg(command: str, cwd: str = "", shell: str = "cmd") -> str:
    """后台启动长任务（dev server、长构建等），立即返回。之后用 bg_output 看输出、bg_stop 停止。"""
    try:
        workdir = _abs(cwd) if str(cwd or "").strip() else None
        _BG_SEQ[0] += 1
        key = f"bg-{os.getpid()}-{_BG_SEQ[0]}"
        log = os.path.join(_bg_logdir(), key + ".log")
        common = dict(cwd=workdir, stdout=open(log, "ab"), stderr=subprocess.STDOUT,
                      stdin=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
        if shell == "powershell":
            proc = subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], **common)
        else:
            proc = subprocess.Popen(command, shell=True, **common)
        _BG[key] = {"proc": proc, "log": log, "cmd": command[:200]}
        return json.dumps({"ok": True, "key": key, "pid": proc.pid, "log": log})
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def bg_output(key: str, tail_bytes: int = 8000) -> str:
    """读取后台任务的输出日志尾部，并报告是否仍在运行与退出码。"""
    try:
        h = _BG.get(key)
        if not h:
            return json.dumps({"ok": False, "error": f"未知任务: {key}（服务重启后句柄丢失，可用 read_file 读日志文件）"})
        proc = h["proc"]
        alive = proc.poll() is None
        size = os.path.getsize(h["log"])
        with open(h["log"], "rb") as f:
            if size > tail_bytes:
                f.seek(size - tail_bytes)
            data = f.read()
        return json.dumps({"ok": True, "key": key, "running": alive, "exit_code": None if alive else proc.returncode,
                           "log_bytes": size, "output": _decode(data)})
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def bg_stop(key: str) -> str:
    """停止一个后台任务（先 terminate，5 秒不退再 kill）。"""
    try:
        h = _BG.get(key)
        if not h:
            return json.dumps({"ok": False, "error": f"未知任务: {key}"})
        proc = h["proc"]
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        return json.dumps({"ok": True, "key": key, "exit_code": proc.returncode})
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def read_pdf(path: str, pages: str = "", max_chars: int = 60000) -> str:
    """读取 PDF 文本。pages 如 "1-5" 或 "3"；留空读全部；超出 max_chars 截断。"""
    try:
        from pypdf import PdfReader
        p = _abs(path)
        r = PdfReader(p)
        total = len(r.pages)
        ps = (pages or "").strip()
        if ps and "-" in ps:
            a, b = ps.split("-", 1)
            idx = range(max(1, int(a)), min(total, int(b)) + 1)
        elif ps:
            idx = [min(total, int(ps))]
        else:
            idx = range(1, total + 1)
        chunks, used = [], 0
        for i in idx:
            t = (r.pages[i - 1].extract_text() or "").strip()
            if not t:
                continue
            if used + len(t) > max_chars:
                chunks.append(f"[p{i}] …(超出 max_chars 截断)")
                break
            chunks.append(f"[p{i}] {t}")
            used += len(t)
        return json.dumps({"ok": True, "path": p, "pages_total": total, "text": "\n".join(chunks)}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def read_docx(path: str, max_chars: int = 60000) -> str:
    """读取 Word .docx 的段落与表格文本（不支持老 .doc 二进制格式）。"""
    try:
        import docx
        p = _abs(path)
        d = docx.Document(p)
        parts, used = [], 0
        for para in d.paragraphs:
            t = para.text.strip()
            if not t:
                continue
            parts.append(t)
            used += len(t)
            if used > max_chars:
                break
        for tb in d.tables:
            if used > max_chars:
                break
            for row in tb.rows:
                line = " | ".join(c.text.strip() for c in row.cells)
                parts.append(line)
                used += len(line)
                if used > max_chars:
                    break
        return json.dumps({"ok": True, "path": p, "paragraphs": len(d.paragraphs), "tables": len(d.tables),
                           "text": "\n".join(parts)[:max_chars + 10]}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def read_xlsx(path: str, sheet: str = "", max_rows: int = 200, max_cols: int = 40) -> str:
    """读取 Excel .xlsx（sheet 留空取第一个），返回行数组。"""
    try:
        import openpyxl
        p = _abs(path)
        wb = openpyxl.load_workbook(p, data_only=True, read_only=True)
        ws = wb[sheet] if sheet and sheet in wb.sheetnames else wb[wb.sheetnames[0]]
        rows = []
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i >= max(1, int(max_rows)):
                break
            rows.append(["" if v is None else str(v) for v in row[:max_cols]])
        names, used = wb.sheetnames, ws.title
        wb.close()
        return json.dumps({"ok": True, "path": p, "sheets": names, "sheet_used": used, "rows": rows}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


def _html_to_text(html: str) -> str:
    html = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", html)
    html = re.sub(r"(?is)<br\s*/?>|</p>|</div>|</li>|</h[1-6]>|</tr>", "\n", html)
    html = re.sub(r"(?is)<[^>]+>", " ", html)
    import html as _html
    text = _html.unescape(html)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


@server.tool()
@watched
async def web_fetch(url: str, max_bytes: int = 200000) -> str:
    """抓取网页并去掉 HTML 标签返回正文文本（仅 http/https）。AI 端可自行总结。"""
    try:
        import httpx
        u = str(url).strip()
        if not u.lower().startswith(("http://", "https://")):
            return json.dumps({"ok": False, "error": "仅支持 http/https"})
        async with httpx.AsyncClient(follow_redirects=True, timeout=20,
                                     headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) arena-desktop-mcp"}) as cli:
            resp = await cli.get(u)
        ctype = resp.headers.get("content-type", "")
        raw = resp.content[: max(4096, int(max_bytes))]
        if "html" in ctype or raw[:1] == b"<":
            text = _html_to_text(raw.decode(resp.encoding or "utf-8", errors="replace"))
        else:
            text = _decode(raw)
        return json.dumps({"ok": True, "url": str(resp.url), "status": resp.status_code,
                           "content_type": ctype, "bytes": len(resp.content), "text": text[:int(max_bytes)]})
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def web_search(query: str, max_results: int = 8) -> str:
    """网页搜索（实验性，走 Bing 网页解析）。若运行环境自带搜索工具请优先用自带的。"""
    try:
        import httpx
        import html as _html
        async with httpx.AsyncClient(follow_redirects=True, timeout=20,
                                     headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}) as cli:
            resp = await cli.get("https://www.bing.com/search", params={"q": query, "setlang": "zh-hans"})
        results = []
        for m in re.finditer(r'<li class="b_algo".*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>(.*?)</a></h2>(.*?)</li>', resp.text, re.S):
            href = _html.unescape(m.group(1))
            # Bing 跳转链 /ck/a?...&u=a1<base64真实url> —— 还原真实地址
            mu = re.search(r"[?&]u=a1([A-Za-z0-9_-]+)", href)
            if mu:
                try:
                    b64 = mu.group(1)
                    b64 += "=" * (-len(b64) % 4)
                    real = base64.urlsafe_b64decode(b64).decode("utf-8", errors="replace")
                    if real.startswith("http"):
                        href = real
                except Exception:
                    pass
            title = _html.unescape(re.sub(r"<[^>]+>", "", m.group(2))).strip()
            snippet = _html.unescape(re.sub(r"<[^>]+>", " ", m.group(3)))
            snippet = " ".join(snippet.split())[:200]
            results.append({"title": title, "url": href, "snippet": snippet})
            if len(results) >= max(1, int(max_results)):
                break
        return json.dumps({"ok": True, "query": query, "count": len(results), "results": results,
                           "note": "实验性网页解析，结果可能不完整"}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


# ---------------- 浏览器控制（双后端：扩展桥=主浏览器 / 受管实例兜底） ----------------

_BROWSER = {"pw": None, "ctx": None}
BROWSER_PROFILE = os.path.join(_ROOT, "data", "browser-profile")
_BRIDGE = {"server": None, "ws": None, "pending": {}, "seq": [0], "send_lock": None}
BRIDGE_PORT = 8768


async def _ensure_bridge():
    """启动本机 WS 桥（127.0.0.1:8768）：装了扩展的主浏览器会主动连进来。"""
    if _BRIDGE["server"] is not None:
        return
    import websockets
    lock = asyncio.Lock()
    _BRIDGE["send_lock"] = lock

    async def handler(ws):
        _BRIDGE["ws"] = ws
        try:
            async for raw in ws:
                try:
                    m = json.loads(raw)
                except Exception:
                    continue
                fut = _BRIDGE["pending"].pop(str(m.get("id")), None)
                if fut is not None and not fut.done():
                    fut.set_result(m)
        except Exception:
            pass
        finally:
            if _BRIDGE.get("ws") is ws:
                _BRIDGE["ws"] = None

    _BRIDGE["server"] = await websockets.serve(handler, "127.0.0.1", BRIDGE_PORT)

    async def heartbeat():
        while True:
            await asyncio.sleep(20)
            try:
                ws = _BRIDGE.get("ws")
                if ws is not None:
                    async with lock:
                        await ws.send(json.dumps({"id": f"h{time.time()}", "action": "ping", "cmd": {}}))
            except Exception:
                pass
    asyncio.create_task(heartbeat())


async def _bridge(action: str, cmd: dict = None, timeout: float = 25):
    """扩展桥已连接则执行并返回 {"data"/"error"}；未连接返回 None（调用方走受管实例兜底）。"""
    await _ensure_bridge()
    ws = _BRIDGE.get("ws")
    if ws is None:
        return None
    _BRIDGE["seq"][0] += 1
    mid = f"m{_BRIDGE['seq'][0]}"
    fut = asyncio.get_running_loop().create_future()
    _BRIDGE["pending"][mid] = fut
    try:
        async with _BRIDGE["send_lock"]:
            await ws.send(json.dumps({"id": mid, "action": action, "cmd": cmd or {}}))
        r = await asyncio.wait_for(fut, timeout)
    except asyncio.TimeoutError:
        _BRIDGE["pending"].pop(mid, None)
        return {"error": f"桥响应超时（{action}）"}
    except Exception as e:
        return {"error": str(e)}
    finally:
        _BRIDGE["pending"].pop(mid, None)
    if not r.get("ok"):
        return {"error": str(r.get("error"))}
    return {"data": r.get("data")}


async def _bridge_tab_id(tab_index):
    """把标签页索引换成扩展侧 tabId。返回 (tabId, last_list_result)。"""
    lst = await _bridge("tabs.list")
    if lst is None or "error" in lst:
        return None, lst
    tabs = lst.get("data") or []
    if not tabs:
        return None, {"error": "浏览器没有打开的标签页"}
    i = len(tabs) - 1 if tab_index is None or int(tab_index) < 0 else max(0, min(int(tab_index), len(tabs) - 1))
    return tabs[i]["tabId"], lst


async def _get_browser(headless: bool = False):
    """兜底：启动/复用受管浏览器（独立配置目录，优先 Edge→Chrome→内置）。"""
    if _BROWSER["ctx"] is not None:
        try:
            _ = _BROWSER["ctx"].pages
            return _BROWSER["ctx"]
        except Exception:
            _BROWSER["ctx"] = None
    from playwright.async_api import async_playwright
    if _BROWSER["pw"] is None:
        _BROWSER["pw"] = await async_playwright().start()
    os.makedirs(BROWSER_PROFILE, exist_ok=True)
    last_err = None
    for channel in ("msedge", "chrome", None):
        try:
            kw = dict(user_data_dir=BROWSER_PROFILE, headless=headless)
            ctx = (await _BROWSER["pw"].chromium.launch_persistent_context(channel=channel, **kw)
                   if channel else
                   await _BROWSER["pw"].chromium.launch_persistent_context(**kw))
            _BROWSER["ctx"] = ctx
            return ctx
        except Exception as e:
            last_err = e
    raise RuntimeError(f"无法启动浏览器（已尝试 msedge/chrome/内置 chromium）: {last_err}")


def _norm_url(url):
    """智能归一化 URL：不破坏 file:// / about: / data: / 本地绝对路径。"""
    u = str(url).strip().strip('"').strip("'")
    if not u:
        return u
    low = u.lower()
    for scheme in ("http://", "https://", "file://", "about:", "data:", "chrome://", "edge://",
                   "view-source:", "ftp://", "mailto:"):
        if low.startswith(scheme):
            return u
    # Windows 绝对路径 C:\xxx 或 C:/xxx -> file:///
    if re.match(r"^[a-zA-Z]:[\\/]", u):
        return "file:///" + u.replace("\\", "/")
    # 纯本地存在的路径
    try:
        if os.path.exists(u):
            return "file:///" + os.path.abspath(u).replace("\\", "/")
    except Exception:
        pass
    if u.startswith("/"):
        return "file:///" + u
    return "https://" + u


def _pick_page(ctx, index):
    pages = list(ctx.pages) or []
    if not pages:
        return None
    if index is None or int(index) < 0:
        return pages[-1]
    return pages[max(0, min(int(index), len(pages) - 1))]


@server.tool()
@watched
async def browser_start(headless: bool = False) -> str:
    """检查/建立浏览器控制通道。装了 Arena MCP Bridge 扩展的主浏览器会显示 mode=extension；
    否则启动受管浏览器实例（独立配置目录，登录态保留；headless=True 纯后台）。"""
    try:
        b = await _bridge("ping")
        if b is not None and "data" in b:
            lst = await _bridge("tabs.list")
            n = len(lst["data"]) if lst and "data" in lst else 0
            return json.dumps({"ok": True, "mode": "extension", "note": "已连接主浏览器扩展桥", "tabs": n}, ensure_ascii=False)
        ctx = await _get_browser(headless)
        return json.dumps({"ok": True, "mode": "managed", "tabs": len(ctx.pages),
                           "note": "扩展未连接，已启动受管实例；装扩展可改为控制主浏览器（见 extension/安装说明.md）"}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def browser_tabs() -> str:
    """列出浏览器所有标签页（索引/标题/URL）。扩展桥优先，未装扩展则用受管实例。"""
    b = await _bridge("tabs.list")
    if b is not None:
        if "error" in b:
            return json.dumps({"ok": False, "error": "桥: " + b["error"]}, ensure_ascii=False)
        tabs = b["data"]
        return json.dumps({"ok": True, "mode": "extension", "count": len(tabs),
                           "tabs": [{"index": t["index"], "title": t["title"][:80], "url": t["url"],
                                     "group": t.get("group", "") or ""} for t in tabs]},
                          ensure_ascii=False)
    try:
        ctx = await _get_browser(False)
        tabs = [{"index": i, "title": (await p.title())[:80], "url": p.url} for i, p in enumerate(ctx.pages)]
        return json.dumps({"ok": True, "mode": "managed", "count": len(tabs), "tabs": tabs}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def browser_open(url: str) -> str:
    """在浏览器里新开一个后台标签页并加载 url（不抢焦点）。返回标签页索引。"""
    u = _norm_url(url)
    b = await _bridge("tabs.new", {"url": u})
    if b is not None:
        if "error" in b:
            return json.dumps({"ok": False, "error": "桥: " + b["error"]}, ensure_ascii=False)
        lst = await _bridge("tabs.list")
        idx, title, taburl = -1, "", u
        if lst and "data" in lst:
            for t in lst["data"]:
                if t["tabId"] == b["data"]["tabId"]:
                    idx, title, taburl = t["index"], t["title"], t["url"]
        return json.dumps({"ok": True, "mode": "extension", "index": idx, "title": title, "url": taburl}, ensure_ascii=False)
    try:
        ctx = await _get_browser(False)
        page = await ctx.new_page()
        await page.goto(u, timeout=30000, wait_until="domcontentloaded")
        idx = list(ctx.pages).index(page)
        return json.dumps({"ok": True, "mode": "managed", "index": idx, "title": (await page.title())[:80], "url": page.url}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def browser_navigate(url: str, tab_index: int = -1) -> str:
    """在指定标签页（-1=最新）里导航到 url。"""
    u = _norm_url(url)
    tid, lst = await _bridge_tab_id(tab_index)
    if tid is not None:
        b = await _bridge("navigate", {"tabId": tid, "url": u})
        if b is not None:
            if "error" in b:
                return json.dumps({"ok": False, "error": "桥: " + b["error"]}, ensure_ascii=False)
            lst2 = await _bridge("tabs.list")
            title = next((t["title"] for t in (lst2.get("data") or []) if t["tabId"] == tid), "")
            return json.dumps({"ok": True, "mode": "extension", "title": title, "url": u}, ensure_ascii=False)
    try:
        ctx = await _get_browser(False)
        page = _pick_page(ctx, tab_index)
        if page is None:
            return json.dumps({"ok": False, "error": "没有打开的标签页"})
        await page.goto(u, timeout=30000, wait_until="domcontentloaded")
        return json.dumps({"ok": True, "mode": "managed", "title": (await page.title())[:80], "url": page.url}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def browser_act(tab_index: int, action: str, selector: str = "", text: str = "", key: str = "") -> str:
    """对指定标签页执行页面操作（后台执行，不碰你的鼠标键盘）。

    action 取值：
      click   —— 点 selector。selector 支持三种写法：
                   CSS 选择器          "#id" / "button.submit"
                   text=可见文本        "text=删除仓库"（自动取最内层、优先精确匹配）
                   aria=标签            "aria=搜索"
      type    —— 向 selector 填 text（会对 React/Vue 触发正确事件）
      clear   —— 清空输入框
      select  —— 对 <select> 选中 text 指定的选项（值或显示文本都行）
      check / uncheck —— 勾选/取消勾选
      hover   —— 鼠标悬停（触发下拉菜单）
      focus   —— 聚焦并点一下
      press   —— 按键 key（如 Enter / Escape / Tab）
      scroll  —— 滚动 text 像素
      wait    —— 等 selector 出现，最多 text 毫秒（默认 8000）
      get     —— 读取元素信息，text 可为 text/value/html/href/attr/checked/count（attr 时用 key 指定属性名）
      fill    —— 批量填表：text 传 JSON 对象 {"#user":"abc","text=密码":"123"}，一次填多个
      snapshot—— 列出页面所有可操作元素（AI 的眼睛；不知道选择器时先用它看）
      eval    —— 执行 selector 里的 JS 表达式，返回结果

    返回 {ok:true, result:{...}}；失败返回 {ok:false, error:"具体原因"}。
    """
    if str(action).lower() in ("reload_extension", "extension_reload"):
        b = await _bridge("reload")
        if b is None:
            return json.dumps({"ok": False, "error": "扩展未连接，无法重载"}, ensure_ascii=False)
        return json.dumps({"ok": True, "note": "扩展已请求重载，约 10 秒后自动重连"}, ensure_ascii=False)
    if str(action).lower() == "version":
        b = await _bridge("version")
        if b is None:
            return json.dumps({"ok": False, "error": "扩展未连接"}, ensure_ascii=False)
        return json.dumps({"ok": True, "bridge_version": b.get("data")}, ensure_ascii=False)
    tid, _l = await _bridge_tab_id(tab_index)
    if tid is not None:
        b = await _bridge("act", {"tabId": tid, "action": action, "selector": selector, "text": text, "key": key})
        if b is not None:
            if "error" in b:
                return json.dumps({"ok": False, "error": "桥: " + b["error"]}, ensure_ascii=False)
            data = b.get("data")
            if isinstance(data, dict):
                return json.dumps({"ok": True, "mode": "extension", "result": data}, ensure_ascii=False)
            return json.dumps({"ok": True, "mode": "extension", "result": str(data)[:300]}, ensure_ascii=False)
    try:
        ctx = await _get_browser(False)
        page = _pick_page(ctx, tab_index)
        if page is None:
            return json.dumps({"ok": False, "error": "没有打开的标签页"})
        a = action.lower()
        if a == "click":
            await page.locator(selector).first.click(timeout=8000)
            out = {"clicked": selector}
        elif a == "type":
            await page.locator(selector).first.fill(text, timeout=8000)
            out = {"typed": len(text)}
        elif a == "clear":
            await page.locator(selector).first.fill("", timeout=8000)
            out = {"cleared": selector}
        elif a == "select":
            await page.locator(selector).first.select_option(text, timeout=8000)
            out = {"selected": text}
        elif a == "check":
            await page.locator(selector).first.check(timeout=8000)
            out = {"checked": True}
        elif a == "uncheck":
            await page.locator(selector).first.uncheck(timeout=8000)
            out = {"checked": False}
        elif a == "hover":
            await page.locator(selector).first.hover(timeout=8000)
            out = {"hovered": selector}
        elif a == "focus":
            await page.locator(selector).first.focus(timeout=8000)
            out = {"focused": selector}
        elif a == "press":
            await page.keyboard.press(key or "Enter")
            out = {"pressed": key or "Enter"}
        elif a == "scroll":
            await page.mouse.wheel(0, int(text or 600))
            out = {"scrollY": await page.evaluate("window.scrollY")}
        elif a == "wait":
            await page.locator(selector).first.wait_for(state="visible", timeout=int(text or 8000))
            out = {"found": True}
        elif a == "get":
            what = (text or "text").lower()
            loc = page.locator(selector).first
            if what == "value":
                out = {"value": await loc.input_value(timeout=8000)}
            elif what == "href":
                out = {"value": await loc.get_attribute("href", timeout=8000)}
            elif what == "attr":
                out = {"value": await loc.get_attribute(key or "href", timeout=8000)}
            elif what == "html":
                out = {"value": (await loc.inner_html(timeout=8000))[:4000]}
            else:
                out = {"value": (await loc.inner_text(timeout=8000))[:4000]}
        elif a == "eval":
            out = {"value": await page.evaluate(selector or text or "1+1")}
        elif a == "fill":
            payload = json.loads(text) if isinstance(text, str) else (text or {})
            done, miss = {}, []
            for k, v in payload.items():
                try:
                    await page.locator(k).first.fill(str(v), timeout=6000)
                    done[k] = str(v)[:40]
                except Exception:
                    miss.append(k)
            out = {"filled": done, "missing": miss}
        elif a == "snapshot":
            out = {"value": (await page.evaluate(
                "() => [...document.querySelectorAll('a,button,input,textarea,select,summary,[role=button]')]"
                ".filter(e => e.offsetParent !== null).slice(0, 150)"
                ".map((e, i) => ({ i, tag: e.tagName.toLowerCase(), text: (e.innerText || e.value || e.placeholder || '').trim().slice(0, 60), id: e.id ? '#' + e.id : undefined }))"))}
        else:
            return json.dumps({"ok": False, "error": "action 只支持 click/type/clear/select/check/uncheck/hover/focus/press/scroll/wait/get/fill/snapshot/eval"},
                              ensure_ascii=False)
        return json.dumps({"ok": True, "mode": "managed", "result": out}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)


@server.tool()
@watched
async def browser_read(tab_index: int = -1, max_chars: int = 12000) -> str:
    """读取指定标签页（-1=最新）的实时标题、URL 与正文文本。"""
    tid, _l = await _bridge_tab_id(tab_index)
    if tid is not None:
        b = await _bridge("read", {"tabId": tid})
        if b is not None:
            if "error" in b:
                return json.dumps({"ok": False, "error": "桥: " + b["error"]}, ensure_ascii=False)
            d = b.get("data") or {}
            return json.dumps({"ok": True, "mode": "extension",
                               "title": d.get("title", ""), "url": d.get("url", ""),
                               "text": (d.get("text") or "")[:max_chars]}, ensure_ascii=False)
    try:
        ctx = await _get_browser(False)
        page = _pick_page(ctx, tab_index)
        if page is None:
            return json.dumps({"ok": False, "error": "没有打开的标签页"})
        title, url, text = await page.title(), page.url, await page.evaluate("() => (document.body ? document.body.innerText : '')")
        return json.dumps({"ok": True, "mode": "managed", "title": title, "url": url, "text": text[:max_chars]}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def browser_shot(tab_index: int = -1, full_page: bool = False) -> str:
    """只截指定标签页（-1=最新）的画面（不影响你的桌面），返回 JPEG base64（img_base64 字段）。"""
    tid, _l = await _bridge_tab_id(tab_index)
    if tid is not None:
        b = await _bridge("shot", {"tabId": tid})
        if b is not None:
            if "error" in b:
                return json.dumps({"ok": False, "error": "桥: " + b["error"]}, ensure_ascii=False)
            return json.dumps({"ok": True, "mode": "extension", "img_base64": _img_to_jpeg_b64(b["data"]), "format": "jpeg"})
    try:
        ctx = await _get_browser(False)
        page = _pick_page(ctx, tab_index)
        if page is None:
            return json.dumps({"ok": False, "error": "没有打开的标签页"})
        data = await page.screenshot(type="jpeg", quality=75, full_page=full_page, timeout=20000)
        return json.dumps({"ok": True, "mode": "managed", "img_base64": base64.b64encode(data).decode(), "format": "jpeg"})
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def browser_group(tab_indices: list, name: str = "Arena") -> str:
    """把若干标签页（索引列表，来自 browser_tabs）合并为一个命名标签分组。仅扩展模式支持（控制主浏览器时可用）。"""
    lst = await _bridge("tabs.list")
    if lst is None:
        return json.dumps({"ok": False, "error": "标签分组需要主浏览器扩展模式（安装 extension/ 里的扩展）"}, ensure_ascii=False)
    if "error" in lst:
        return json.dumps({"ok": False, "error": "桥: " + lst["error"]}, ensure_ascii=False)
    tabs = lst.get("data") or []
    ids = [tabs[int(i)]["tabId"] for i in tab_indices if 0 <= int(i) < len(tabs)]
    if not ids:
        return json.dumps({"ok": False, "error": "没有有效的标签页索引"}, ensure_ascii=False)
    b = await _bridge("tabs.group", {"tabIds": ids, "name": name})
    if "error" in b:
        return json.dumps({"ok": False, "error": "桥: " + b["error"]}, ensure_ascii=False)
    return json.dumps({"ok": True, "mode": "extension", "grouped": len(ids), "name": name}, ensure_ascii=False)


@server.tool()
@watched
async def browser_close() -> str:
    """扩展模式下不关闭你的主浏览器（仅结束受管实例，登录态保留）。"""
    b = await _bridge("ping")
    if b is not None:
        return json.dumps({"ok": True, "mode": "extension", "note": "扩展桥不需要关闭；你的主浏览器保持原样"}, ensure_ascii=False)
    if _BROWSER["ctx"] is not None:
        try:
            await _BROWSER["ctx"].close()
        except Exception:
            pass
        _BROWSER["ctx"] = None
    return json.dumps({"ok": True, "mode": "managed"})


# ---------------- 会话接力工具 ----------------

import relay_pack  # noqa: E402  (同目录，提供 ZCode/Codex 会话读取)


@server.tool()
@watched
async def session_list(source: str = "all", days: int = 14, limit: int = 20) -> str:
    """列出本地近期 AI 会话。source: all/zcode/codex；返回标题、工作目录、更新时间与 key（供 session_read/session_relay 使用）。"""
    try:
        sessions = relay_pack.list_sessions(source, days, limit)
        return json.dumps({"ok": True, "count": len(sessions), "sessions": sessions}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def session_read(source: str, key: str, last_messages: int = 30) -> str:
    """读取一个本地会话的近期对话。zcode 的 key 是会话 ID（session_list 返回），codex 的 key 是 rollout 文件路径。"""
    try:
        src = (source or "").lower()
        if src == "zcode":
            sess, msgs, todos = relay_pack._zcode_messages(key, last_messages)
            if sess is None:
                return json.dumps({"ok": False, "error": f"未找到会话: {key}"})
            return json.dumps({"ok": True, "title": sess["title"], "directory": sess["directory"],
                               "todos": todos,
                               "messages": [{"role": r, "text": relay_pack._clip(t, 800)} for r, t in msgs]}, ensure_ascii=False)
        if src == "codex":
            cwd, msgs = relay_pack._codex_messages(key, last_messages)
            return json.dumps({"ok": True, "directory": cwd,
                               "messages": [{"role": r, "text": relay_pack._clip(t, 800)} for r, t in msgs]}, ensure_ascii=False)
        return json.dumps({"ok": False, "error": "source 只支持 zcode / codex"})
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


@server.tool()
@watched
async def session_relay(source: str, key: str, last_messages: int = 30, extra_note: str = "") -> str:
    """生成完整的会话接力包文本（工作目录 + 待办 + 近期对话 + 本地工具连接说明），可直接发给新的 AI 会话继续任务。"""
    try:
        return relay_pack.build_package(source, key, last_messages, extra_note=extra_note)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)})


if __name__ == "__main__":
    # Existing SSH forwarding reaches the loopback MCP endpoint.
    server.run(transport="streamable-http")
