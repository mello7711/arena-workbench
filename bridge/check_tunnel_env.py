# -*- coding: utf-8 -*-
"""隧道环境健康检查：判断本机代理/VPN/TUN 是否在干扰到 VPS 的 SSH 隧道。

为什么需要这个脚本：
  代理工具（Clash / FlClash / Clash Verge / Surge / 各类 TUN 模式 VPN）会接管
  本机出站 TCP。当目标连不上时，部分实现返回「假握手」——socket.connect()
  报成功，但数据包没出去。SSH 因此报
  "kex_exchange_identification: Connection closed by remote host"，
  看起来像服务端封了你，其实是本地代理骗了你。

判定思路（重点）：
  TUN 模式下，连任何端口都会「连接成功」（它在本地终止 TCP），所以
  「连接成功」本身不代表网络干净。真正可靠的判据是：
  能不能拿到服务端返回的 SSH banner（SSH-2.0-...）。
  - 拿到 banner  → 数据真的到达了 VPS，隧道能建
  - 拿不到 banner → 被劫持/被拦/服务端异常

用法：
    .venv\\Scripts\\python.exe bin\\check_tunnel_env.py
或双击 检查隧道环境.cmd
"""
import socket
import sys
import time

VPS_HOST = "{{VPS_HOST}}"
VPS_PORT = {{SSH_PORT_VPS}}
CONTROL_PORTS = [65530, 9999, 12345]


def probe(host, port, timeout=6.0):
    """返回 (是否连接成功, 耗时)。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    t0 = time.time()
    try:
        s.connect((host, port))
        return True, time.time() - t0
    except Exception:
        return False, time.time() - t0
    finally:
        try:
            s.close()
        except Exception:
            pass


def ssh_banner(host, port, timeout=8.0):
    """连接并读取 SSH banner。返回 (状态, banner_bytes)。
    状态: 'ok' | 'closed' | 'silent' | 'error'
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        s.settimeout(timeout)
        try:
            data = s.recv(128)
        except socket.timeout:
            return "silent", b""
        if not data:
            return "closed", b""
        return "ok", data
    except Exception:
        return "error", b""
    finally:
        try:
            s.close()
        except Exception:
            pass


def main():
    print("=" * 58)
    print(" 隧道环境健康检查")
    print("=" * 58)
    print(f" 目标: {VPS_HOST}:{VPS_PORT}")
    print()

    # 第 1 步：TUN 探测
    print("[1] 探测本机是否有 TUN / 代理劫持")
    fake = 0
    for p in CONTROL_PORTS:
        ok, dt = probe(VPS_HOST, p)
        if ok:
            fake += 1
        print(f"    端口 {p:>5}: {'连接成功' if ok else '失败'}  ({dt:.2f}s)")

    tun_mode = fake > 0
    if tun_mode:
        print()
        print("    → 检测到 TUN/代理劫持：连不可能开放的端口也报成功。")
        print("      注意：这本身不一定是故障，TUN 会在本地终止 TCP。")
        print("      真正的判据看下面第 [2] 步的 SSH banner。")
    else:
        print()
        print("    → 无劫持：连不上的端口确实失败，网络直连。")

    # 第 2 步：SSH banner（唯一可靠判据）
    print()
    print("[2] SSH 协议层（决定性判据）")
    status, data = ssh_banner(VPS_HOST, VPS_PORT)
    if status == "ok" and data.startswith(b"SSH-"):
        banner_txt = data.split(b"\r\n")[0].decode("ascii", "replace")
        print(f"    收到 SSH banner: {banner_txt}")
        print()
        print("=" * 58)
        print(" 结果：环境正常，数据真实到达 VPS，隧道可以建立。")
        if tun_mode:
            print(" （TUN 开着也没问题——说明直连/绕过规则已生效）")
        print("=" * 58)
        return 0

    # 失败分支
    if status == "closed":
        print("    连接成功但立即关闭（0 字节）← 典型被劫持/被封")
    elif status == "silent":
        print("    连接成功但等不到 banner ← 被劫持或链路中断")
    elif status == "error":
        print("    连接失败 ← 目标不可达")
    else:
        print(f"    收到非 SSH 数据: {data[:60]!r}")

    print()
    print("[判定] 数据没能真正到达 VPS 的 sshd，隧道建不起来。")
    print()
    print("[怎么修] 按顺序试：")
    print("   1) 完全退出代理软件（FlClash/Clash Verge/VPN 等），重跑本检查")
    print("      → 如果这时通了，就确定是代理造成的")
    print("   2) 关闭代理的 TUN / 虚拟网卡 / 增强模式，只留系统代理")
    print("   3) 在代理【订阅 profile】里（不是临时 config.yaml）加直连规则：")
    print(f"        - 'IP-CIDR,{VPS_HOST}/32,DIRECT,no-resolve'")
    print(f"        - 'DST-PORT,{VPS_PORT},DIRECT'")
    print("      位置必须放在 'MATCH' 之前；改完要在客户端里重新加载订阅")
    print("   4) 或在代理的「绕过/直连」列表里加入该 IP")
    print()
    print("   如果代理已完全退出仍然不通 → 问题在 VPS 侧：")
    print("      sshd 监听、NAT 映射、防火墙/fail2ban、出口 IP 限制")
    return 1


if __name__ == "__main__":
    sys.exit(main())
