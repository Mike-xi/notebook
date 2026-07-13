# coding: utf-8
"""
Guidance —— 制导决策层：航点状态机 + ILOS + 双通道规避 + 经济巡航
=================================================================
全部判定只用估计值与跟踪器输出（纯感知数据），不读真值。

设计要点（引擎调参踩坑固化，见 PROJECT.md 2026-07-05）：
  * 静态障碍不用"速度CPA+航向偏置"，用路径坐标系"航线冲突"几何判威胁、
    "横向偏移线"执行 —— 保留完整横偏反馈，不漂移不猎振，横流下也稳；
  * 让开侧须锁定（障碍在航路线上时符号逐拍翻转会摆头直插）；
  * 静态目标零速度先验、出FOV短时记忆（Vision 层）；
  * 静态障碍不减速（转向权威随航速降，减速反被顺流抬进障碍）；
  * 动态障碍（水面漂浮物/船）走"速度CPA+时间门"，规避通道=下潜穿越；
  * 桥墩"窄门"= 两侧偏移约束自动解出走中央；
  * 经济巡航：沿航迹地速伺服到 U_DES，顺流自动收油门 → 能耗/米最优。
"""
import math
from .Params import *


class Mission:
    def __init__(self, waypoints, width=10.0, start_z=0.4, loop=False, et_lim=ET_LIM):
        self.wps = [list(w) for w in waypoints]
        self.width = width
        self.start_z = start_z
        self.loop = loop
        self.et_lim = et_lim
        self.reset(0.0, 0.0)

    def reset(self, x0, y0):
        self.state = 'IDLE'
        self.wp_i = 0
        self.e_int = 0.0
        self.base = 0.55
        self.psi_d = 0.0
        self.zref = self.start_z
        self.threat = None
        self.avoid_count = 0
        self.avoid_mode = None
        self.avoid_t = 0.0
        self.clear_t = 0.0
        self.slow = 1.0
        self.leg_from = [x0, y0]
        self.e = 0.0
        self.eT = 0.0
        self.lo = None            # 偏移约束区间（None=无界）
        self.hi = None
        self.route_rev = 0        # 航段变化计数（网页据此重画航线）
        self.laps = 0
        self._e_sum = 0.0
        self._e_n = 0
        self.events = []

    def start(self, est):
        self.reset(est.x, est.y)
        self.state = 'TRANSIT'
        self.events.append('🚀 任务开始：按序巡航 %d 个巡逻点' % len(self.wps))

    def pop_events(self):
        ev, self.events = self.events, []
        return ev

    # ---------------- 主决策（RATE_DECIDE Hz 调用） ----------------
    def tick(self, tracks, est, dt_d):
        if self.state == 'IDLE':
            return
        if self.state == 'DONE':
            self.zref = 0.03
            self.base = 0.0
            return

        # ---- 航点状态机 ----
        wp = self.wps[self.wp_i]
        if math.hypot(wp[0] - est.x, wp[1] - est.y) < WP_R:
            mean_e = self._e_sum / self._e_n if self._e_n else 0.0
            self.events.append('📍 抵达巡逻点 <b>%d/%d</b>（估计横偏均值 %.2f m）'
                               % (self.wp_i + 1, len(self.wps), mean_e))
            self.leg_from = [wp[0], wp[1]]
            self.wp_i += 1
            self.e_int = 0.0
            self.route_rev += 1
            if self.wp_i >= len(self.wps):
                if self.loop:
                    self.wp_i = 0
                    self.laps += 1
                    self.events.append('🔁 一圈完成，继续巡逻（第 %d 圈）' % (self.laps + 1))
                else:
                    self.state = 'DONE'
                    self.events.append('✅ 全部巡逻点完成，排水上浮待回收')
                    return
        wpn = self.wps[self.wp_i]

        # ---- 航路几何（估计坐标系） ----
        dx = wpn[0] - self.leg_from[0]
        dy = wpn[1] - self.leg_from[1]
        path_ang = math.atan2(dy, dx)
        lp = math.hypot(dx, dy) or 1e-6
        ex = est.x - self.leg_from[0]
        ey = est.y - self.leg_from[1]
        e = (ey * dx - ex * dy) / lp
        self.e = e
        self._e_sum += abs(e)
        self._e_n += 1

        # ---- 威胁评估（跟踪器输出 + 估计速度，纯感知数据） ----
        dive_draft = -1.0
        prime, prime_u = None, 0.0
        n_static = 0
        lo, hi = -math.inf, math.inf
        for tr in tracks:
            tr.cpa = None
            px, py = tr.x - est.x, tr.y - est.y
            rg = math.hypot(px, py)
            # 看门狗：连续规避 >AVOID_DEADLOCK_T 视为僵持，收紧余量脱困
            rs = (tr.r + MARGIN) * (0.85 if self.avoid_t > AVOID_DEADLOCK_T else 1.0)
            if tr.full:
                # 静态障碍＝路径坐标系"航线冲突"几何（与艏向/瞬时速度解耦）
                alongd = px * math.cos(path_ang) + py * math.sin(path_ang)
                if alongd < -0.5 or alongd > 5.5:
                    continue
                e_obs = ((tr.y - self.leg_from[1]) * dx - (tr.x - self.leg_from[0]) * dy) / lp
                sep = e - e_obs
                dc = abs(sep)
                if dc >= rs:
                    continue
                # 让开侧锁定；被水流整体带到另一侧(>0.8m)则顺势重锁
                sgn = 1 if sep > 0 else (-1 if sep < 0 else 0)
                if not tr.side or (sgn != tr.side and dc > 0.8):
                    tr.side = sgn or 1
                # 偏移约束：从 tr.side 侧以 rs 间隔通过（近距应急再加宽）
                req = e_obs + tr.side * (rs + (0.25 if rg < rs * 0.85 else 0.0))
                if tr.side > 0:
                    lo = max(lo, req)
                else:
                    hi = min(hi, req)
                n_static += 1
                urg = (1 - dc / rs) * clamp(1 - alongd / 6.0, 0.35, 1.0)
                if rg < rs * 0.85:
                    urg = max(urg, 0.6)
                tr.cpa = {'d': dc, 't': clamp(alongd, 0.0, 5.5) / U_DES, 'rg': rg}
                if urg > prime_u:
                    prime_u, prime = urg, tr
            else:
                # 动态障碍＝速度 CPA + 时间门（判的就是相对运动，要"错时"）
                vx_r, vy_r = tr.vx - est.vx, tr.vy - est.vy
                v2 = vx_r * vx_r + vy_r * vy_r
                if rg < rs * 0.8 or v2 < 1e-4:
                    tc, dc = 0.0, rg
                else:
                    tcr = -(px * vx_r + py * vy_r) / v2
                    if tcr < -0.5 or tcr > HORIZON:
                        continue
                    tcp = max(0.0, tcr)
                    dc = math.hypot(px + vx_r * tcp, py + vy_r * tcp)
                    tc = clamp(tcr, 0.0, HORIZON)
                if dc >= rs:
                    continue
                urg = (1 - dc / rs) * clamp(1 - tc / (HORIZON * 1.2), 0.25, 1.0)
                if rg < rs * 0.85:
                    urg = max(urg, 0.45 + (rs * 0.85 - rg) / (rs * 0.85))
                if urg <= 0.05:
                    continue
                tr.cpa = {'d': dc, 't': tc, 'rg': rg}
                dive_draft = max(dive_draft, tr.draft)
                if urg > prime_u:
                    prime_u, prime = urg, tr

        # ---- 静态规避＝局部航路横向偏移 eT：约束区间内取离原航线最近点 ----
        eT = 0.0
        if n_static:
            if lo > hi:
                eT = (lo + hi) / 2.0     # 区间为空（两侧夹击）取中点
            else:
                eT = max(lo if lo != -math.inf else -1e9,
                         min(hi if hi != math.inf else 1e9, 0.0))
            eT = clamp(eT, -self.et_lim, self.et_lim)
        self.eT = eT
        self.lo = None if lo == -math.inf else lo
        self.hi = None if hi == math.inf else hi

        # ---- 制导：跟踪偏移线（偏移非零时冻结 ILOS 积分，防绕行积偏） ----
        if eT != 0.0:
            psi_d = path_ang + math.atan2(-(e - eT), LOOKAHEAD)
        else:
            denom = LOOKAHEAD ** 2 + (e + KAPPA * self.e_int) ** 2
            self.e_int = clamp(self.e_int + INT_GAIN * (LOOKAHEAD * e / denom) * dt_d,
                               -INT_LIM, INT_LIM)
            psi_d = path_ang + math.atan2(-(e + KAPPA * self.e_int), LOOKAHEAD)

        # ---- 规避通道选择与事件 ----
        mode = None
        if dive_draft >= 0 and n_static:
            mode = 'BOTH'
        elif dive_draft >= 0:
            mode = 'DIVE'
        elif n_static:
            mode = 'STEER'
        if mode:
            self.clear_t = 0.0
            self.avoid_t += dt_d
            if not self.avoid_mode:
                self.avoid_count += 1
                if mode == 'DIVE':
                    act = ('🌊 下潜穿越（漂浮物吃水 %.2f m → 潜至 %.1f m）'
                           % (dive_draft, dive_draft + DIVE_EXTRA))
                else:
                    act = '↪ 绕行规避（横向偏移 %+.1f m 让开航线）' % eT
                pid = '#%d %s' % (prime.id, OB_NAME.get(prime.type, prime.type)) if prime else '?'
                dtxt = ' 间隔 %.1f m' % prime.cpa['d'] if (prime and prime.cpa) else ''
                self.events.append('⚠ 威胁判定 <b>%s</b>%s → %s' % (pid, dtxt, act))
            self.avoid_mode = mode
        elif self.avoid_mode:
            self.clear_t += dt_d
            if self.clear_t > CLEAR_HOLD:
                self.avoid_mode = None
                self.avoid_t = 0.0
                self.events.append('↩ 威胁解除，恢复 ILOS 航线（第 %d 段）' % (self.wp_i + 1))

        # ---- 输出：期望航向 / 目标深度 / 减速 ----
        self.psi_d = psi_d
        # 岸壁斥力（安全兜底）：贴岸且期望航向仍指向岸时，把 y 向分量压回河心
        sgn_x = 1.0 if math.cos(self.psi_d) >= 0 else -1.0
        if est.y < BANK_KEEPOUT and math.sin(self.psi_d) < 0:
            self.psi_d = math.atan2(0.35 * (BANK_KEEPOUT - est.y), sgn_x)
        if est.y > self.width - BANK_KEEPOUT and math.sin(self.psi_d) > 0:
            self.psi_d = math.atan2(-0.35 * (est.y - self.width + BANK_KEEPOUT), sgn_x)
        self.zref = (max(wpn[2], dive_draft + DIVE_EXTRA)
                     if (self.avoid_mode in ('DIVE', 'BOTH') and dive_draft >= 0)
                     else wpn[2])
        self.threat = prime
        # 减速只对动态障碍（让船先过）；静态障碍减速有害（见文件头注释）
        if (prime is None) or (prime.cpa is None) or prime.full:
            self.slow = 1.0
        elif prime.cpa['rg'] < prime.r + MARGIN:
            self.slow = 0.45
        elif prime.cpa['t'] < 3.5 and prime.cpa['d'] < (prime.r + MARGIN) * 0.8:
            self.slow = 0.45
        elif prime.cpa['t'] < 5.0 and prime.cpa['d'] < (prime.r + MARGIN) * 0.7:
            self.slow = 0.55
        else:
            self.slow = 1.0
        # ---- 经济巡航：沿航迹地速伺服到 U_DES ----
        u_along = est.vx * math.cos(path_ang) + est.vy * math.sin(path_ang)
        self.base = clamp(self.base + 0.5 * (U_DES - u_along) * dt_d, BASE_MIN, BASE_MAX)
