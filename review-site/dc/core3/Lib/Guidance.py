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
        self._blk_t = 0.0         # 当前航点被障碍占据的持续时间
        self._emer_id = None      # 近场应急目标（去重播报用）
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

        # ---- 航点状态机：抵达圈 或 正横越过（沿航迹投影超过航段长）即切换。
        #      只判抵达圈会在"障碍逼出偏移、够不到抵达圈"时错过航点——LOS
        #      跟的是航段线不是点，错过后会沿延长线一直开、永不回头 ----
        wp = self.wps[self.wp_i]
        dxw = wp[0] - self.leg_from[0]
        dyw = wp[1] - self.leg_from[1]
        lpw = math.hypot(dxw, dyw) or 1e-6
        s_along = ((est.x - self.leg_from[0]) * dxw + (est.y - self.leg_from[1]) * dyw) / lpw
        hit = math.hypot(wp[0] - est.x, wp[1] - est.y) < WP_R
        if hit or s_along > lpw + 0.25:
            mean_e = self._e_sum / self._e_n if self._e_n else 0.0
            self.events.append('📍 %s巡逻点 <b>%d/%d</b>（估计横偏均值 %.2f m）'
                               % ('抵达' if hit else '正横越过',
                                  self.wp_i + 1, len(self.wps), mean_e))
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

        # ---- 航点被障碍占据（如临时投放/拖动的障碍压住航点）：短驻留即跳过。
        #      判据=障碍圆+安全裕量吃掉抵达圆的大部分（此时绕行约束和"够到
        #      航点"互斥）；驻留须短——拖到 3s 机器人已贴近障碍，再转向
        #      新航点时会擦碰（探针实测 6cm 擦碰）----
        near_wp = math.hypot(wpn[0] - est.x, wpn[1] - est.y) < 6.5
        blocked = near_wp and any(
            tr.static and math.hypot(wpn[0] - tr.x, wpn[1] - tr.y) < tr.r + MARGIN * 0.75 + WP_R
            for tr in tracks)
        self._blk_t = self._blk_t + dt_d if blocked else 0.0
        if self._blk_t > 1.0:
            self._blk_t = 0.0
            self.events.append('⛔ 航点 <b>%d</b> 被障碍占据 → 跳过，直奔下一航点' % (self.wp_i + 1))
            self.leg_from = [est.x, est.y]
            self.wp_i += 1
            self.e_int = 0.0
            self.route_rev += 1
            if self.wp_i >= len(self.wps):
                if self.loop:
                    self.wp_i = 0
                else:
                    self.state = 'DONE'
                    self.events.append('✅ 巡逻结束（末航点被占据），排水上浮')
            return

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
        emer, emer_d = None, math.inf
        lo, hi = -math.inf, math.inf
        for tr in tracks:
            tr.cpa = None
            px, py = tr.x - est.x, tr.y - est.y
            rg = math.hypot(px, py)
            # 看门狗：连续规避 >AVOID_DEADLOCK_T 视为僵持，收紧余量脱困
            rs = (tr.r + MARGIN) * (0.85 if self.avoid_t > AVOID_DEADLOCK_T else 1.0)
            # 近场应急：走廊失效后的"最后防线"（0.65×安全距才触发）。
            # 仅限静态目标——动态目标（大鱼）超越中本就长时间近距同行；
            # 方位门（<52°）只拦"正对着怼上去"的。⚠️触发不能早：径向逃逸
            # 不认识其它约束，1.8m 就抢舵曾把机器人从礁石推进旁边的鱼身上
            if tr.static and rg < rs * 0.65 and rg < emer_d:
                brg_e = abs(wrap(math.atan2(py, px) - est.psi))
                if brg_e < 0.9:
                    emer, emer_d = tr, rg
                    if tr.cpa is None:
                        tr.cpa = {'d': rg, 't': 0.0, 'rg': rg}
            if tr.static:
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
                deep = tr.draft + DIVE_EXTRA > Z_DIVE_MAX
                # ① 深吃水动态目标（大鱼等全水深活动物）：潜不过去 → 按"会
                #    移动的静态障碍"生成走廊约束。不等 CPA 报警——顶流悬停/
                #    慢速目标相对速度小，CPA 门要贴到 rs 才触发，太晚；含
                #    1.5s 横向速度前馈抵消蛇形摆动与本艇响应滞后。
                #    不套看门狗收紧——同向超越本就要长时间纠缠
                if deep:
                    # 鱼类目标加 25% 走廊余量：它自己会动，横向收敛存在
                    # 追踪滞后，且定位漂移（模拟 VO 有界漂移，限幅 0.25m）
                    # 会整体平移走廊——1.15 倍时漂移大的运行 minClear 仅
                    # 0.09m（静态障碍/桥墩门不受影响）。
                    # O9-lite：轨迹不成熟（新生/断链重捕，streak<VIS_MATURE）
                    # 时速度不可信——前馈按成熟度打折，走廊再加保守膨胀；
                    # 成熟后两者平滑回到原值，行为与旧版一致
                    mat = clamp(getattr(tr, 'streak', VIS_MATURE) / VIS_MATURE, 0.0, 1.0)
                    rs_d = tr.r + MARGIN * 1.25 + VIS_INFLATE * (1.0 - mat)
                    alongd = px * math.cos(path_ang) + py * math.sin(path_ang)
                    if -0.5 <= alongd <= 5.5:
                        e_obs = ((tr.y - self.leg_from[1]) * dx
                                 - (tr.x - self.leg_from[0]) * dy) / lp
                        e_obs += 1.5 * mat * (tr.vy * dx - tr.vx * dy) / lp
                        sep = e - e_obs
                        dcl = abs(sep)
                        if dcl < rs_d:
                            sgn = 1 if sep > 0 else (-1 if sep < 0 else 0)
                            if not tr.side or (sgn != tr.side and dcl > 0.8):
                                tr.side = sgn or 1
                            req = e_obs + tr.side * (rs_d + (0.25 if rg < rs_d * 0.85 else 0.0))
                            if tr.side > 0:
                                lo = max(lo, req)
                            else:
                                hi = min(hi, req)
                            n_static += 1
                            tr.cpa = {'d': dcl, 't': clamp(alongd, 0.0, 5.5) / U_DES, 'rg': rg}
                            urg0 = (1 - dcl / rs_d) * clamp(1 - alongd / 6.0, 0.35, 1.0)
                            if urg0 > prime_u:
                                prime_u, prime = urg0, tr
                # ② 速度 CPA + 时间门（相对运动"错时"判定）：浅吃水目标 →
                #    下潜穿越；深吃水目标的 CPA 只补充威胁度（横穿预警）
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
                if tr.cpa is None:
                    tr.cpa = {'d': dc, 't': tc, 'rg': rg}
                if not deep:
                    dive_draft = max(dive_draft, tr.draft)
                if urg > prime_u:
                    prime_u, prime = urg, tr

        # ---- 静态规避＝局部航路横向偏移 eT：约束区间内取离原航线最近点 ----
        eT = 0.0
        if n_static:
            if lo > hi:
                # 约束冲突＝障碍间隙 < 安全宽度（如大鱼贴着礁石游）：取中点
                # 等于硬穿缝，必撞——须从全部障碍外侧绕。选边也不能只看偏移
                # 代价：切换横位的过渡段可能斜穿另一障碍（曾 3/3 撞礁石）。
                # 用"候选航向的近程射线净距"选边：谁的过渡路径离障碍远走谁
                def ray_min_clr(cand):
                    psi_c = path_ang + math.atan2(-(e - cand), LOOKAHEAD)
                    cx, cy = math.cos(psi_c), math.sin(psi_c)
                    worst = math.inf
                    for t2 in tracks:
                        if not (t2.static or t2.cpa):
                            continue
                        ox, oy = t2.x - est.x, t2.y - est.y
                        along = ox * cx + oy * cy
                        if -0.2 <= along <= 3.5:
                            worst = min(worst, abs(ox * cy - oy * cx) - t2.r)
                    return worst
                cl, ch = ray_min_clr(lo), ray_min_clr(hi)
                if abs(cl - ch) > 0.15:
                    eT = lo if cl > ch else hi
                else:
                    eT = lo if abs(lo - e) <= abs(hi - e) else hi
            else:
                eT = max(lo if lo != -math.inf else -1e9,
                         min(hi if hi != math.inf else 1e9, 0.0))
            eT = clamp(eT, -self.et_lim, self.et_lim)
        self.eT = eT
        self.lo = None if lo == -math.inf else lo
        self.hi = None if hi == math.inf else hi

        # ---- 制导：跟踪偏移线（偏移非零时冻结 ILOS 积分，防绕行积偏；
        #      用短前视 LOOKAHEAD_AVOID——拐角后突现障碍需要果断的横向机动） ----
        if eT != 0.0:
            psi_d = path_ang + math.atan2(-(e - eT), LOOKAHEAD_AVOID)
        else:
            denom = LOOKAHEAD ** 2 + (e + KAPPA * self.e_int) ** 2
            self.e_int = clamp(self.e_int + INT_GAIN * (LOOKAHEAD * e / denom) * dt_d,
                               -INT_LIM, INT_LIM)
            psi_d = path_ang + math.atan2(-(e + KAPPA * self.e_int), LOOKAHEAD)

        # ---- 近场应急（突现/被移入贴身的全水深障碍）：径向逃逸压过 ILOS。
        #      偏移线是"沿航段"的走廊几何，对突然出现在身侧的障碍反应不及
        #      （曾在立柱拖拽测试中贴身碰撞）；越贴近逃逸权重越高 ----
        if emer is not None:
            away = math.atan2(est.y - emer.y, est.x - emer.x)
            rs_e = (emer.r + MARGIN) * 0.65
            k = clamp(1.5 * (1.0 - emer_d / rs_e), 0.5, 1.0)
            psi_d = psi_d + k * wrap(away - psi_d)
            n_static = max(n_static, 1)          # 归入 STEER 规避通道
            if prime is None:
                prime = emer
            if self._emer_id != emer.id:
                self._emer_id = emer.id
                self.events.append('🚨 近场应急：<b>#%d %s</b> 距 %.1f m → 径向避让'
                                   % (emer.id, OB_NAME.get(emer.type, emer.type), emer_d))
        else:
            self._emer_id = None

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
        # 减速只对动态障碍（让船/鱼先走）；静态障碍减速有害（见文件头注释）。
        # 深吃水的鱼也减速：绕行的横向收敛需要沿程距离，收油门直接买时间
        if (prime is None) or (prime.cpa is None) or prime.static:
            self.slow = 1.0
        elif prime.cpa['rg'] < prime.r + MARGIN:
            self.slow = 0.45
        elif prime.cpa['t'] < 3.5 and prime.cpa['d'] < (prime.r + MARGIN) * 0.8:
            self.slow = 0.45
        elif prime.cpa['t'] < 5.0 and prime.cpa['d'] < (prime.r + MARGIN) * 0.7:
            self.slow = 0.55
        else:
            self.slow = 1.0
        # 过弯减速（叠乘）：航向误差大时收油门——拐角盲区后突现障碍的
        # 反应距离随航速线性增加，这也是实船的标准操纵习惯
        herr = abs(wrap(self.psi_d - est.psi))
        if herr > 0.4:
            self.slow = min(self.slow, clamp(1.0 - 0.7 * (herr - 0.4), 0.5, 1.0))
        # 近障限速（叠乘）：前方 4m 内有确认目标（|方位|<60°）→ 航速≤0.6×。
        # 绕行的横向收敛需要沿程距离，贴近障碍时慢下来是标准 AUV 操作
        for tr in tracks:
            dxo, dyo = tr.x - est.x, tr.y - est.y
            if (dxo * dxo + dyo * dyo < 16.0
                    and abs(wrap(math.atan2(dyo, dxo) - est.psi)) < 1.05):
                self.slow = min(self.slow, 0.6)
                break
        # ---- 经济巡航：沿航迹地速伺服到 U_DES ----
        u_along = est.vx * math.cos(path_ang) + est.vy * math.sin(path_ang)
        self.base = clamp(self.base + 0.5 * (U_DES - u_along) * dt_d, BASE_MIN, BASE_MAX)
