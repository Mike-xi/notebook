# coding: utf-8
"""
Formation —— 图论一致性分布式编队协同（阶段三成果）
=====================================================
对应任务书阶段三第 2、3 项：基于图论一致性协议的分布式编队控制器，
支持「领航-跟随」与「无领航一致性」两种结构，实现 3 机队形保持 /
队形变换 / 航点协同，并在通信拓扑切换与个体失效下保持鲁棒。

设计（每机本地只用"邻居共享的估计"，无任何全局信息 → 天然分布式）：

  ┌ 分布式参考观测器 (ξ_i, ζ_i) ── 一阶一致性 + pinning ────────────┐
  │  每机维护对"编队虚拟质心参考"的本地估计 (位置 ξ_i、速度 ζ_i)。    │
  │  只靠邻居交换令各机估计一致地收敛到共同参考 —— 这是"无领航一致性" │
  │  的核心；把 pinning 增益接到某台真参考上即得"领航-跟随"。         │
  │      ξ̇_i = ζ_i                                                  │
  │      ζ̇_i = -γ Σ_j a_ij[(ξ_i-ξ_j)+(ζ_i-ζ_j)] - b_i k[(ξ_i-r)+..]│
  └──────────────────────────────────────────────────────────────┘
  ┌ 队形反馈 ── 邻居相对位形一致性 ────────────────────────────────┐
  │  期望位形 p_i* = ξ_i + Rot(ψ_f)·δ_i（δ_i 体系槽位偏移）。       │
  │  除跟自己的槽位误差外，再加"邻居相对偏差一致性项"                │
  │      Σ_j a_ij[(p_i-p_j) - (δ_i-δ_j)]                            │
  │  它直接惩罚"僚机之间的相对队形漂移"，是队形保持的一致性来源，      │
  │  单靠各自跟槽位（星形依赖质心）在拓扑残缺时会散架。               │
  └──────────────────────────────────────────────────────────────┘

产物是每机的期望 (航向 ψd, 目标深度 zref, 经济油门基值 base)，正好是
阶段一 Control.Controller.tick() 的 mission 接口 —— 编队层与单机运动控制层
零改动级联，与"装机同款"的 Lib 一脉相承。

鲁棒性：
  * 拓扑用邻接矩阵 A 表达，运行时可整行/整列置零 = 通信链路增删/切换；
  * 个体失效 = 从活跃集合摘除，其邻居自动把它从求和里剔除，剩余机在
    残余连通图上重构一致（只要活跃子图仍连通、且至少一台受 pinning）。
"""
import math
from .Params import *


def rot2(dx, dy, psi):
    """体系偏移 (前 dx, 右 dy) 按编队航向 psi 旋转到世界系 (NED: x前 y右)。"""
    c, s = math.cos(psi), math.sin(psi)
    return (c * dx - s * dy, s * dx + c * dy)


class Formation:
    """分布式一致性编队控制器（集中在一处仿真 N 机的本地协议，等价于各机各跑一份）。

    结构：
      mode='leader'   领航-跟随：0 号为领队，只有它受参考 pinning，僚机纯靠邻居一致；
      mode='leaderless' 无领航一致性：所有活跃机都挂一个弱 pinning 到共同参考，
                        参考本身由任务（航点/巡航速度）生成 —— 无单点。
    """

    def __init__(self, n=3, mode='leaderless', shape='三角'):
        self.n = n
        self.mode = mode
        self.use_consensus = True   # 对照开关：True=图论一致性协同；False=各机独立跟参考(基线)
        self.set_shape(shape, morph=False)
        # 邻接矩阵（无向环 + 弦，3 机默认全连通）；对角为 0
        self.A = [[0.0] * n for _ in range(n)]
        self.ring_topology()
        self.reset()

    # ---------------- 拓扑 ----------------
    def ring_topology(self):
        """默认无向环（每机与相邻两机通信）。3 机时即全连通三角。"""
        n = self.n
        for i in range(n):
            for j in range(n):
                self.A[i][j] = 1.0 if (abs(i - j) == 1 or abs(i - j) == n - 1) and i != j else 0.0

    def set_edge(self, i, j, on):
        """增删一条无向通信边（拓扑切换用）。"""
        v = 1.0 if on else 0.0
        self.A[i][j] = v
        self.A[j][i] = v

    def line_topology(self):
        """链式拓扑 0-1-2（去掉环的闭合弦），演示"拓扑切换后仍保持队形"。"""
        for i in range(self.n):
            for j in range(self.n):
                self.A[i][j] = 1.0 if abs(i - j) == 1 else 0.0

    # ---------------- 队形 ----------------
    def set_shape(self, shape, morph=True):
        """切换目标队形。morph=True 时在 FORM_MORPH_T 内从当前偏移线性过渡（防阶跃）。"""
        target = [tuple(d) for d in FORMATIONS[shape]][:self.n]
        while len(target) < self.n:
            target.append((0.0, 0.0, 0.0))
        self.shape = shape
        if not morph or not hasattr(self, 'delta'):
            self.delta = [list(d) for d in target]
            self.delta_from = [list(d) for d in target]
            self.delta_to = [list(d) for d in target]
            self.morph_t = 0.0
        else:
            self.delta_from = [list(d) for d in self.delta]
            self.delta_to = [list(d) for d in target]
            self.morph_t = FORM_MORPH_T

    def _morph_step(self, dt):
        if self.morph_t > 0.0:
            self.morph_t = max(0.0, self.morph_t - dt)
            a = 1.0 - self.morph_t / FORM_MORPH_T
            for i in range(self.n):
                for k in range(3):
                    self.delta[i][k] = (1 - a) * self.delta_from[i][k] + a * self.delta_to[i][k]

    # ---------------- 生命周期 ----------------
    def reset(self, ests=None):
        self.alive = [True] * self.n
        # 分布式参考观测器状态：每机本地对"编队质心参考"的估计
        self.xi = [[0.0, 0.0] for _ in range(self.n)]    # 位置估计 (x,y)
        self.zeta = [[0.0, 0.0] for _ in range(self.n)]  # 速度估计 (vx,vy)
        self.xi_z = [0.0] * self.n                        # 深度参考本地估计
        self.psi_f = 0.0                                  # 编队航向（由参考速度定向）
        self.psi_d = [0.0] * self.n
        self.zref = [0.4] * self.n
        self.base = [0.0] * self.n
        self.spd_i = [0.0] * self.n     # 各机地速闭环积分器（自校准油门，克服欠驱动滞后）
        self.events = []
        if ests is not None:
            # 观测器初值取各机自身估计，避免启动冲刺
            for i in range(self.n):
                self.xi[i] = [ests[i].x, ests[i].y]
                self.xi_z[i] = ests[i].z

    def fail(self, i):
        if self.alive[i]:
            self.alive[i] = False
            self.events.append('❌ 个体 <b>%d 号</b> 失效退出，剩余机在残余拓扑上重构一致' % (i + 1))

    def revive(self, i):
        if not self.alive[i]:
            self.alive[i] = True
            self.events.append('✅ 个体 <b>%d 号</b> 恢复并重新入队' % (i + 1))

    def pop_events(self):
        ev, self.events = self.events, []
        return ev

    # ---------------- 主协议（RATE_DECIDE Hz） ----------------
    def tick(self, ests, ref, dt):
        """一次分布式编队决策。
        ests : [StateEstimator ...]  各机融合估计（本机对邻居的"共享估计"）
        ref  : {'x','y','z','vx','vy'} 编队虚拟质心参考（任务层给：航点巡航/LOS）
        dt   : 决策周期
        输出写入 self.psi_d / self.zref / self.base（供各机 Controller 使用）。
        """
        self._morph_step(dt)
        n, A = self.n, self.A
        rx, ry = ref['x'], ref['y']
        rvx, rvy = ref.get('vx', 0.0), ref.get('vy', 0.0)
        rz = ref.get('z', 0.4)

        # pinning 分配 b_i：领航-跟随只 pin 领队(0)；无领航所有活跃机弱 pin
        if self.mode == 'leader':
            b = [FORM_K_PIN if (i == 0 and self.alive[i]) else 0.0 for i in range(n)]
            # 领队失效 → 自动把 pinning 递补给编号最小的活跃机（去单点依赖）
            if not self.alive[0]:
                for i in range(n):
                    if self.alive[i]:
                        b[i] = FORM_K_PIN
                        break
        else:
            b = [(0.5 * FORM_K_PIN if self.alive[i] else 0.0) for i in range(n)]

        # ---- ① 分布式参考观测器：一阶一致性 + pinning（只用邻居 ξ,ζ 与本机是否受信）----
        if not self.use_consensus:
            # 基线（对照组）：经典"纯领航-跟随"星形结构，无机间协同、无 pinning 递补 ——
            # 领航模式下领队固定为 0 号：领队跟全局参考，僚机只把"领队实测位置"当锚点
            # 各自保持偏移，僚机之间不通信、领队失效也不递补。领队一旦失效→僚机失去唯一
            # 锚点、队形崩溃。这正是图论一致性要克服的短板（一致性分支用邻居中继+pin递补）。
            if self.mode == 'leader':
                anchor = 0 if self.alive[0] else None
            else:
                # 无领航基线：各机都能弱感知参考，但互不协调（退化为独立跟参考）
                anchor = 'ref'
            for i in range(n):
                if anchor == 'ref':
                    self.xi[i][0], self.xi[i][1] = rx, ry
                    self.zeta[i][0], self.zeta[i][1] = rvx, rvy
                    self.xi_z[i] = rz
                elif anchor is not None:
                    if i == anchor:                        # 领队本机跟全局参考
                        self.xi[i][0], self.xi[i][1] = rx, ry
                        self.zeta[i][0], self.zeta[i][1] = rvx, rvy
                        self.xi_z[i] = rz
                    else:                                  # 僚机以领队实测位置为锚
                        self.xi[i][0], self.xi[i][1] = ests[anchor].x, ests[anchor].y
                        self.zeta[i][0], self.zeta[i][1] = ests[anchor].vx, ests[anchor].vy
                        self.xi_z[i] = ests[anchor].z
                # else: 领队失效且无递补 → xi 保持上一时刻（僚机失去参考，队形发散）
        else:
            dxi = [[0.0, 0.0] for _ in range(n)]
            dzeta = [[0.0, 0.0] for _ in range(n)]
            for i in range(n):
                if not self.alive[i]:
                    continue
                ax, ay = 0.0, 0.0            # 邻居一致性合力（位置+速度）
                for j in range(n):
                    if A[i][j] <= 0 or not self.alive[j]:
                        continue
                    ax += (self.xi[i][0] - self.xi[j][0]) + (self.zeta[i][0] - self.zeta[j][0])
                    ay += (self.xi[i][1] - self.xi[j][1]) + (self.zeta[i][1] - self.zeta[j][1])
                # ξ̇ = ζ ; ζ̇ = -γ·邻居一致 - b·(到真参考误差) + 前馈参考加速度(近似 0)
                dxi[i][0] = self.zeta[i][0]
                dxi[i][1] = self.zeta[i][1]
                dzeta[i][0] = -FORM_K_OBS * ax - b[i] * ((self.xi[i][0] - rx) + (self.zeta[i][0] - rvx))
                dzeta[i][1] = -FORM_K_OBS * ay - b[i] * ((self.xi[i][1] - ry) + (self.zeta[i][1] - rvy))
            for i in range(n):
                if not self.alive[i]:
                    continue
                self.xi[i][0] += dxi[i][0] * dt
                self.xi[i][1] += dxi[i][1] * dt
                self.zeta[i][0] += dzeta[i][0] * dt
                self.zeta[i][1] += dzeta[i][1] * dt
                # 深度：单通道一阶一致性（邻居 + pinning 到参考深度）
                dz = 0.0
                for j in range(n):
                    if A[i][j] > 0 and self.alive[j]:
                        dz += (self.xi_z[i] - self.xi_z[j])
                self.xi_z[i] += (-FORM_K_OBS * dz - b[i] * (self.xi_z[i] - rz)) * dt

        # ---- 编队航向：由参考速度定向（静止时保持上一航向，防定向抖动）----
        rspd = math.hypot(rvx, rvy)
        if rspd > FORM_V_MIN:
            self.psi_f = math.atan2(rvy, rvx)

        # ---- ② 队形反馈：本机槽位跟踪 + 邻居相对位形一致性 ----
        # 关键：先算"期望位移矢量"，再按【编队航向 psi_f】做非完整约束分解 ——
        #   横向分量 → 有界转向（LOS 式，psi_d 始终贴着 psi_f，不反向绕圈）；
        #   纵向分量 → 期望地速增量（沿航向追赶/收敛）。
        # 这样欠驱动半潜器（弱差速转艏、大横向阻力、无法横move）也能稳定收队，
        # 而不是去追一个随位置误差方向乱转的速度矢量指令。
        cpf, spf = math.cos(self.psi_f), math.sin(self.psi_f)
        for i in range(n):
            if not self.alive[i]:
                self.base[i] = 0.0
                continue
            e = ests[i]
            # 期望槽位（世界系）= 本机参考估计 + 旋转后的体系偏移
            offx, offy = rot2(self.delta[i][0], self.delta[i][1], self.psi_f)
            slot_x = self.xi[i][0] + offx
            slot_y = self.xi[i][1] + offy
            # (a) 槽位误差（把自己拉到槽位）
            ux = FORM_K_TRACK * (slot_x - e.x)
            uy = FORM_K_TRACK * (slot_y - e.y)
            # (b) 邻居相对队形一致性：Σ a_ij[(p_i-p_j) - (δ_i^w-δ_j^w)] 取负 —— 队形保持核心
            #     基线模式(use_consensus=False)下关闭邻居项：各机只盯自己的槽位、互不协调。
            if self.use_consensus:
                for j in range(n):
                    if A[i][j] <= 0 or not self.alive[j]:
                        continue
                    ej = ests[j]
                    djx, djy = rot2(self.delta[j][0], self.delta[j][1], self.psi_f)
                    rel_x = (e.x - ej.x) - (offx - djx)
                    rel_y = (e.y - ej.y) - (offy - djy)
                    ux -= FORM_K_FORM * rel_x
                    uy -= FORM_K_FORM * rel_y
            # 位移误差按编队航向分解：along 沿航向、cross 右舷
            along = ux * cpf + uy * spf
            cross = -ux * spf + uy * cpf
            # 横偏 → LOS 式有界转向（相对编队航向），杜绝反向绕圈
            psi_off = clamp(math.atan2(cross, FORM_LOOKAHEAD), -FORM_PSI_MAX, FORM_PSI_MAX)
            self.psi_d[i] = wrap(self.psi_f + psi_off)
            # 期望地速 = 参考推进速度(始终保留前馈) + 纵向收敛项。
            #   欠驱动艇转艏慢：正在大角度转向时暂缓追赶(乘 cos(psi_off))，转正后再补速，
            #   避免"斜着猛冲"把队形冲散；指令地速上限 V_MAX(<<极速) 留足追赶余量。
            v_cmd = clamp(rspd + FORM_K_ALONG * along * max(0.3, math.cos(psi_off)),
                          FORM_V_TRACK_MIN, FORM_V_MAX)
            # 地速闭环：期望地速 v_cmd 对比本机实测沿航向地速，积分自校准油门增益，
            # 使指令与真实"油门→速度"增益无关（简化水池 / 网页完整动力学通吃）。
            v_meas = e.vx * math.cos(self.psi_d[i]) + e.vy * math.sin(self.psi_d[i])
            self.spd_i[i] = clamp(self.spd_i[i] + FORM_SPD_KI * (v_cmd - v_meas) * dt,
                                  -FORM_SPD_LIM, FORM_SPD_LIM)
            base_cmd = FORM_BASE_K * v_cmd + self.spd_i[i]
            base_clamped = clamp(base_cmd, BASE_MIN, BASE_MAX)
            # 抗积分饱和：油门顶格时回退积分器（防绕圈滞后累积）
            if base_clamped != base_cmd:
                self.spd_i[i] = clamp(base_clamped - FORM_BASE_K * v_cmd, -FORM_SPD_LIM, FORM_SPD_LIM)
            self.base[i] = base_clamped
            # 目标深度：跟本机深度参考估计 + 体系深度偏移（立体队形）
            self.zref[i] = clamp(self.xi_z[i] + self.delta[i][2], 0.05, 2.0)

    # ---------------- 供网页 HUD 的诊断量 ----------------
    def formation_error(self, ests):
        """队形误差 RMS [m]：各活跃机实际位置 vs 期望槽位（相对编队质心）。
        这是评估"队形保持"精度的核心指标，越小越紧。"""
        acc, k = 0.0, 0
        # 用活跃机实际质心作为队形中心（消除整体平移，只看队形本身）
        cx = cy = 0.0
        na = 0
        for i in range(self.n):
            if self.alive[i]:
                cx += ests[i].x
                cy += ests[i].y
                na += 1
        if na == 0:
            return 0.0
        cx /= na
        cy /= na
        # 期望槽位质心（同样只取活跃机）
        sx = sy = 0.0
        for i in range(self.n):
            if self.alive[i]:
                ox, oy = rot2(self.delta[i][0], self.delta[i][1], self.psi_f)
                sx += ox
                sy += oy
        sx /= na
        sy /= na
        for i in range(self.n):
            if not self.alive[i]:
                continue
            ox, oy = rot2(self.delta[i][0], self.delta[i][1], self.psi_f)
            want_x = cx + (ox - sx)
            want_y = cy + (oy - sy)
            acc += (ests[i].x - want_x) ** 2 + (ests[i].y - want_y) ** 2
            k += 1
        return math.sqrt(acc / k) if k else 0.0

    def consensus_error(self):
        """一致性误差 [m]：各机对"编队质心参考"本地估计 ξ_i 之间的最大分歧。
        无领航一致性收敛的直接度量 —— 趋于 0 表示全体对参考达成一致。"""
        act = [i for i in range(self.n) if self.alive[i]]
        if len(act) < 2:
            return 0.0
        mx = 0.0
        for a in range(len(act)):
            for b2 in range(a + 1, len(act)):
                i, j = act[a], act[b2]
                d = math.hypot(self.xi[i][0] - self.xi[j][0], self.xi[i][1] - self.xi[j][1])
                mx = max(mx, d)
        return mx

    def is_connected(self):
        """活跃子图是否连通（失效后仍能一致的前提）。BFS。"""
        act = [i for i in range(self.n) if self.alive[i]]
        if not act:
            return False
        seen = {act[0]}
        stack = [act[0]]
        while stack:
            u = stack.pop()
            for v in range(self.n):
                if v not in seen and self.alive[v] and self.A[u][v] > 0:
                    seen.add(v)
                    stack.append(v)
        return len(seen) == len(act)
