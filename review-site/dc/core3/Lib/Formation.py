# coding: utf-8
"""
Formation —— 基于图论一致性协议的分布式编队制导（阶段三核心模块，v2 重写）
==========================================================================
参考文献：
  * Ren & Beard, "Distributed Consensus in Multi-vehicle Cooperative Control", 2008
  * 任务书 v2 参考 [10] 多AUV编队避障一致性控制, IEEE/CAA JAS 2023
  * 任务书 v2 参考 [11] 执行器故障与切换拓扑下多AUV分布式一致性编队, EJC 2024

v2 重写动机（v1 闭环实测缺陷，见 记录\\阶段三_编队实验记录.md）：
  v1 把一致性输出压成"限幅 0.5m/s 的修正"再与领航航向混合——误差大时跟随者
  基本平行于领航者航向飞而不指向队位，第一个航点转弯（航向仅变 23°）即被甩开
  5~7m 且追赶极慢；队位随 leader_psi_d 在航点切换瞬间跳变，又与机间斥力正反馈，
  32 组闭环实验 RMS 1.4~2.7m、最小机间距 0.076m。

v2 制导律（速度场合成，仍是一致性协议的运动学外环形态）：
  跟随者 i 的期望速度向量：
    v_i^d = v_ref                                    ← 领航（参考）速度前馈
          + sat( K_p · e_slot , V_PURSUIT )          ← 队位追踪（饱和 P，误差大时
                                                        直指队位，不再被混合稀释）
          + Σ_j a_ij [ K_c·((p_j-p_i)-(δ_j-δ_i)) + K_v·(v_j-v_i) ]   ← 邻居一致性
          + u_ca                                      ← 机间防撞斥力（全员，含领航）
  然后 psi_d = atan2(v_i^d)、u_d = |v_i^d|（限幅 FORM_U_MAX），
  油门 = 标定前馈 (u/0.96)² + 速度伺服 K_bu·(u_d - u_me)。

  队位参考航向 slot_psi：取领航期望航向/虚拟领航航向，但经 FORM_SLOT_SLEW
  限速率平滑——航点切换时队位绕领航者连续旋转而非瞬跳（v1 崩溃主因之一）。

  领航者（leader-follower 的 agent 0）：正常走 ILOS（psi_d/u_d 由 Mission 给），
  仅当机间防撞斥力显著时并入速度合成（v1 领航者完全不避让，是近距的另一半）。

队形定义（formation_offsets）：
  N 个 agent 相对编队参考点的体系偏移 [dx_i, dy_i, dz_i]（NED：x 前 y 右 z 下）。
"""

import math
from .Params import *


# ============================================================
#  内置队形定义（相对编队参考点，NED 坐标系：x 前 y 右 z 下）
# ============================================================
BUILTIN_FORMATIONS = {
    'triangle': [[0.0, 0.0, 0.0],
                 [-1.2, -0.8, 0.0],
                 [-1.2, 0.8, 0.0]],
    'line': [[0.0, 0.0, 0.0],
             [0.0, -1.5, 0.0],
             [0.0, 1.5, 0.0]],
    'column': [[0.0, 0.0, 0.0],
               [-2.0, 0.0, 0.0],
               [-4.0, 0.0, 0.0]],
    # 窄道自适应用的紧缩梯队：从横队收拢时两翼只"后撤+微内收"，
    # 变形路径不交叉（纯纵队收拢时两翼横穿中线互扫，实测机距 0.10m）；
    # 横向 ±0.8 过 3m 级通航孔仍有余量。⚠ 槽位分配必须与横队同侧
    # （跟随1 低边、跟随2 高边）——换边分配会让两翼横穿中线互扫
    # （实测机距 0.075m）；低边贴桥墩的风险由"桥离转弯点 6.5m 回稳
    # 距离"的场景准则兜底
    'gate_column': [[0.0, 0.0, 0.0],
                    [-2.0, -0.8, 0.0],
                    [-4.0, 0.8, 0.0]],
    'diamond': [[0.0, 0.0, 0.0],
                [-1.0, -1.0, 0.0],
                [-1.0, 1.0, 0.0],
                [-2.5, 0.0, 0.0]],
}

# 通信拓扑邻接矩阵模板（无向图，a_ij = a_ji ∈ {0,1}）
# ⚠ 3 机时 ring 与 full 是同一张图（每机都连另外两机）——做拓扑对比实验
#   应当用 chain（0-1-2 链：agent2 看不到领航者，只能靠 agent1 中继一致性）
TOPOLOGY_TEMPLATES = {
    'full': lambda n: [[1 if i != j else 0 for j in range(n)] for i in range(n)],
    'ring': lambda n: [[1 if (i - j) % n in (1, n - 1) else 0 for j in range(n)] for i in range(n)],
    'leader-follower': lambda n: [[0] + [1] * (n - 1)] + [[1] + [0] * (n - 1) for _ in range(n - 1)],
    'chain': lambda n: [[1 if abs(i - j) == 1 else 0 for j in range(n)] for i in range(n)],
}


# ============================================================
#  FormationTopology —— 通信拓扑管理
# ============================================================
class FormationTopology:
    """通信拓扑：无向图/有向图，支持切换与节点失效。

    用法：
        topo = FormationTopology(3, 'full')
        topo.switch('chain')       # 切换到链式拓扑
        topo.drop(1)               # agent 1 掉线（邻接矩阵对应行列清零）
        topo.restore(1)            # 恢复
        neighbors = topo.neighbors_of(0)  # → [1, 2]
    """

    def __init__(self, n_agents, pattern='full'):
        self.n = n_agents
        self._pattern = pattern
        self._base = self._build(pattern)
        self._active = [row[:] for row in self._base]  # 当前生效的邻接矩阵
        self._dropped = set()

    def _build(self, pattern):
        if pattern in TOPOLOGY_TEMPLATES:
            return TOPOLOGY_TEMPLATES[pattern](self.n)
        # 否则视为自定义邻接矩阵
        return [list(row) for row in pattern]

    @property
    def matrix(self):
        return [row[:] for row in self._active]

    @property
    def pattern(self):
        return self._pattern

    def switch(self, pattern):
        """切换通信拓扑模式。"""
        self._pattern = pattern
        self._base = self._build(pattern)
        self._apply_drops()

    def drop(self, agent_id):
        """模拟 agent 通信掉线：其邻接矩阵对应行/列清零（不接收也不发送）。"""
        self._dropped.add(agent_id)
        self._apply_drops()

    def restore(self, agent_id):
        """恢复 agent 通信。"""
        self._dropped.discard(agent_id)
        self._apply_drops()

    def _apply_drops(self):
        self._active = [row[:] for row in self._base]
        for a in self._dropped:
            if 0 <= a < self.n:
                for i in range(self.n):
                    self._active[a][i] = 0
                    self._active[i][a] = 0

    def neighbors_of(self, agent_id):
        """返回 agent_id 在当前激活拓扑下的邻居列表（不含自身）。"""
        if agent_id >= self.n:
            return []
        return [j for j, a in enumerate(self._active[agent_id]) if a > 0]

    def is_connected(self):
        """BFS 检查当前激活拓扑是否连通（无向图，只考虑未掉线节点）。"""
        if self.n == 0:
            return True
        start = None
        for i in range(self.n):
            if i not in self._dropped:
                start = i
                break
        if start is None:
            return True
        visited = {start}
        q = [start]
        while q:
            v = q.pop(0)
            for j in range(self.n):
                if self._active[v][j] > 0 and j not in visited:
                    visited.add(j)
                    q.append(j)
        active_count = self.n - len(self._dropped)
        return len(visited) == active_count

    def summary(self):
        return {
            'pattern': self._pattern,
            'n': self.n,
            'dropped': list(self._dropped),
            'connected': self.is_connected(),
            'edges': [(i, j) for i in range(self.n) for j in range(i + 1, self.n)
                      if self._active[i][j] > 0],
        }


# ============================================================
#  FormationController —— 一致性编队制导器（每个 agent 一个实例）
# ============================================================
class FormationController:
    """单个 agent 的分布式编队制导器（v2 速度场合成）。

    输出与 Control.Controller.tick 兼容的期望量：
        psi_d 期望航向 / u_d 期望地速 / z_d 期望深度 / base 油门 / slow / state
    """

    def __init__(self, agent_id, n_agents, formation='triangle', mode='leader-follower'):
        self.id = agent_id
        self.n = n_agents
        self.mode = mode            # 'leader-follower' | 'leaderless'
        self._formation_name = formation if isinstance(formation, str) else 'custom'
        self._offsets_src = self._resolve_offsets(formation, n_agents)

        # 当前激活的队形偏移（可能正在过渡中）
        self.offsets = [list(o) for o in self._offsets_src]
        self._prev_offsets = [list(o) for o in self._offsets_src]
        self._switch_t = -999.0
        self._switch_done = True

        # 队位参考航向（限速率平滑，防止航点切换瞬跳甩开队形）
        self._slot_psi = None
        # 上一拍队位相对向量（数值微分出队位速度：旋转+队形切换 morph）
        self._prev_rel = None

        # 本 agent 的期望状态（与 Controller.tick 兼容）
        self.state = 'TRANSIT'
        self.psi_d = 0.0
        self.u_d = U_DES
        self.z_d = 0.4
        self.base = 0.55
        self.slow = 1.0

        # 编队质量监控
        self.form_err = 0.0
        self._last_neighbors = []

        # O8 编队安全层：障碍让开侧锁定 {track_id: ±1}
        # （单机的教训：贴线障碍的噪声会让让开侧逐拍翻转→摆头直插，必须锁定）
        self._ob_side = {}
        self._ob_evade = False

    def _resolve_offsets(self, formation, n):
        if isinstance(formation, str):
            if formation in BUILTIN_FORMATIONS:
                return BUILTIN_FORMATIONS[formation]
            return BUILTIN_FORMATIONS['triangle']
        return formation

    # ---------- 队形管理 ----------
    def set_formation(self, formation, t=0.0):
        """切换队形：启动 smooth 过渡（sigmoid 插值，FORM_SWITCH_TAU 秒完成）。"""
        new_offsets = self._resolve_offsets(formation, self.n)
        self._formation_name = formation if isinstance(formation, str) else 'custom'
        self._prev_offsets = [list(o) for o in self.offsets]
        self._offsets_src = [list(o) for o in new_offsets]
        self._switch_t = t
        self._switch_done = False

    def _update_offsets(self, t):
        """Sigmoid 平滑过渡队形偏移量。"""
        if self._switch_done:
            return
        elapsed = t - self._switch_t
        if elapsed >= FORM_SWITCH_TAU:
            self.offsets = [list(o) for o in self._offsets_src]
            self._switch_done = True
            return
        tau = elapsed / FORM_SWITCH_TAU
        alpha = 10.0
        s = 1.0 / (1.0 + math.exp(-alpha * (tau - 0.5)))
        for i in range(min(len(self.offsets), len(self._offsets_src))):
            for d in range(3):
                self.offsets[i][d] = (self._prev_offsets[i][d]
                                      + s * (self._offsets_src[i][d] - self._prev_offsets[i][d]))

    def _world_offsets(self, heading):
        """体系队形偏移 → 世界系（绕 z 旋转 heading）。"""
        c, s = math.cos(heading), math.sin(heading)
        return [[c * o[0] - s * o[1], s * o[0] + c * o[1], o[2]]
                for o in self.offsets]

    def _slew_slot_psi(self, raw_psi, dt):
        """队位参考航向限速率平滑。"""
        if self._slot_psi is None:
            self._slot_psi = raw_psi
            return self._slot_psi
        step = clamp(wrap(raw_psi - self._slot_psi), -FORM_SLOT_SLEW * dt, FORM_SLOT_SLEW * dt)
        self._slot_psi = wrap(self._slot_psi + step)
        return self._slot_psi

    # ---------- 一致性协议（主入口） ----------
    def compute(self, fleet_state, t, dt,
                leader_psi_d=None, leader_u_d=None, leader_z_d=None,
                virtual_leader=None, collision_avoid=None, slot_psi_ref=None,
                obstacles=None):
        """每个决策周期调用一次。

        fleet_state : list of dict —— 各 agent 估计状态（世界系 NED），
            {'id','x','y','z','psi','vx','vy','u','v','zdot'}；
            通信拓扑不可达 / 丢包的 agent 对应项为 None。
        leader_psi_d/u_d/z_d : 领航者 ILOS 期望（领航者广播；跟随者用于队位航向）。
        virtual_leader : 无领航模式虚拟领航者 {'x','y','z','psi','u','vx','vy'}。
        collision_avoid : (ax, ay) 机间防撞斥力（速度量纲），全员适用（含领航）。
        slot_psi_ref : float or None
            队位参考航向的外部指定值（建议传**航段切向**：分段常值，只在
            航点切换时旋转）。不传则退化用 leader_psi_d——但 ILOS 收线时
            psi_d 有 ±8° 的整定振荡，经 1.4m 队形力臂放大成 ±0.5m 横向
            扫摆（诊断记录见 记录\\阶段三_编队实验记录.md）。
        obstacles : list or None（O8 编队安全层）
            本机视觉确认的障碍轨迹（Vision.Track，属性 x/y/r/full/id）。
            静态全水深障碍压在队位槽/归队路径上时侧推让开——领航者的
            Mission 自带走廊规避，此处只对跟随者生效，避免两套规避打架。
        """
        self._update_offsets(t)
        me = fleet_state[self.id]
        if me is None:
            return {'psi_d': self.psi_d, 'u_d': self.u_d, 'z_d': self.z_d,
                    'base': self.base, 'slow': self.slow, 'state': self.state,
                    'form_err': self.form_err}

        is_leader = (self.id == 0 and self.mode == 'leader-follower')

        # ---- 参考体选择 ----
        # leaderless：虚拟领航者（其位置即队形原点，ref_off = 0）；
        # leader-follower：领航者可见 → 领航者；不可见（chain 拓扑中继/
        #   丢包/失效未切模式）→ 以编号最小的可见邻居为**中继参考**，
        #   队位取相对偏移 δ_i - δ_ref —— 这正是一致性协议经邻居间接
        #   收敛到全局队形的机制（路线/航段为任务级先验，所有艇预载）。
        ref = None
        ref_i = None
        ref_off = [0.0, 0.0, 0.0]
        if self.mode == 'leaderless' and virtual_leader is not None:
            ref = virtual_leader
            raw_slot_psi = virtual_leader.get('psi', me['psi'])
        else:
            raw_slot_psi = leader_psi_d if leader_psi_d is not None else me['psi']
            # ⚠ 排除自引用：掉线的 0 号艇曾把自己当参考体 → 前馈=自身速度
            #   = 以巡航速度盲飞，失联安全分支永远走不到
            if fleet_state[0] is not None and self.id != 0:
                ref_i = 0
            else:
                vis = [j for j in range(self.n)
                       if j != self.id and fleet_state[j] is not None]
                if vis:
                    ref_i = min(vis)
            if ref_i is not None:
                ref = fleet_state[ref_i]
                if raw_slot_psi is None:
                    raw_slot_psi = ref.get('psi', me['psi'])
        if slot_psi_ref is not None:
            raw_slot_psi = slot_psi_ref
        slot_psi = self._slew_slot_psi(raw_slot_psi, dt)
        offsets = self._world_offsets(slot_psi)
        if ref_i is not None:
            ref_off = offsets[ref_i]

        neighbors = [j for j in range(self.n)
                     if j != self.id and fleet_state[j] is not None]
        self._last_neighbors = neighbors

        # ---- 期望速度向量合成 ----
        pdx, pdy = 0.0, 0.0        # 队位追踪 + 一致性耦合（可被避撞让步收缩）
        if is_leader:
            base_psi = leader_psi_d if leader_psi_d is not None else self.psi_d
            base_u = leader_u_d if leader_u_d is not None else self.u_d
            vdx = base_u * math.cos(base_psi)
            vdy = base_u * math.sin(base_psi)
        else:
            # ① 参考速度前馈
            if ref is not None:
                vdx = ref.get('vx', 0.0)
                vdy = ref.get('vy', 0.0)
            else:
                # 参考体不可达且无可见邻居（完全失联）：保持航向、降速待联
                u_lost = min(self.u_d, FORM_LOST_U)
                vdx = u_lost * math.cos(self.psi_d)
                vdy = u_lost * math.sin(self.psi_d)

            # ② 队位追踪（饱和 P：误差大时直指队位）
            #    + 队位速度前馈（旋转扫掠/队形切换 morph 时队位本身在动）
            #    + 以队位速度为基准的阻尼（⚠ 只对 ref 速度做阻尼会抵消转弯
            #      所需的合法速度差，实测反而激化瞬态——必须含队位速度）
            if ref is not None:
                rx = offsets[self.id][0] - ref_off[0]
                ry = offsets[self.id][1] - ref_off[1]
                srx = sry = 0.0
                if self._prev_rel is not None and dt > 1e-6:
                    srx = (rx - self._prev_rel[0]) / dt
                    sry = (ry - self._prev_rel[1]) / dt
                    m = math.hypot(srx, sry)
                    if m > FORM_PURSUIT_MAX:   # 前馈限幅到机动余量
                        srx, sry = srx / m * FORM_PURSUIT_MAX, sry / m * FORM_PURSUIT_MAX
                self._prev_rel = (rx, ry)
                vdx += srx
                vdy += sry
                ex = (ref['x'] + rx) - me['x']
                ey = (ref['y'] + ry) - me['y']
                e = math.hypot(ex, ey)
                if e > 1e-6:
                    g = min(FORM_KP * e, FORM_PURSUIT_MAX) / e
                    pdx += g * ex
                    pdy += g * ey
                if FORM_KD > 0.0:
                    slot_vx = ref.get('vx', 0.0) + srx
                    slot_vy = ref.get('vy', 0.0) + sry
                    pdx -= FORM_KD * (me.get('vx', 0.0) - slot_vx)
                    pdy -= FORM_KD * (me.get('vy', 0.0) - slot_vy)

            # ③ 邻居一致性耦合（拓扑约束由调用方以 None 屏蔽体现）
            for j in neighbors:
                if j == ref_i:
                    continue  # 参考体已进入 ①②
                nb = fleet_state[j]
                cdx = (nb['x'] - me['x']) - (offsets[j][0] - offsets[self.id][0])
                cdy = (nb['y'] - me['y']) - (offsets[j][1] - offsets[self.id][1])
                pdx += FORM_KC * cdx + FORM_KV * (nb['vx'] - me['vx'])
                pdy += FORM_KC * cdy + FORM_KV * (nb['vy'] - me['vy'])

        # ④ 障碍斥力（O8 编队安全层，仅跟随者——领航者由 Mission 走廊规避）。
        #    在队位航向坐标系判威胁：前视 FORM_OB_LOOKAHEAD 内、横向间隔小于
        #    r+FORM_OB_MARGIN 的全水深障碍 → 沿锁定侧法向侧推让开，
        #    越过后（沿航迹落到艇后）解除锁定自然归队。
        #    动态全水深目标（大鱼）：位置按 Vision 速度前推 FORM_OB_DYN_LEAD 秒
        #    再走同一套几何——对齐领航者 Guidance 的横向速度前馈；浅吃水动态
        #    目标（渡船类）不进安全层（可下潜通过，归领航者 Mission 决策）。
        self._ob_evade = False
        obax, obay = 0.0, 0.0
        ob_brake = 1.0
        ob_sum = 0.0                     # 各障碍推力标量和（对消死锁检测）
        ob_best = (0.0, 0.0, 0.0)        # 亏欠最大障碍的 (deficit, fx, fy)
        ob_block = []      # 让位期间要封锁的"朝障碍侧"（防归队拉力把艇甩回禁区）
        if obstacles and not is_leader:
            ct_o, st_o = math.cos(slot_psi), math.sin(slot_psi)
            for ob in obstacles:
                if not getattr(ob, 'full', True):
                    continue
                is_dyn = not getattr(ob, 'static', True)
                lead_t = FORM_OB_DYN_LEAD if is_dyn else 0.0
                oid = getattr(ob, 'id', id(ob))
                dx = ob.x + getattr(ob, 'vx', 0.0) * lead_t - me['x']
                dy = ob.y + getattr(ob, 'vy', 0.0) * lead_t - me['y']
                s_al = dx * ct_o + dy * st_o          # 沿队位航向
                lat = -dx * st_o + dy * ct_o          # 横向（右正）
                keep = ob.r + (FORM_OB_DYN_MARGIN if is_dyn
                               else FORM_OB_MARGIN)
                if s_al < -1.2 or s_al > FORM_OB_LOOKAHEAD or abs(lat) > keep + 0.5:
                    # 让开侧锁到障碍完全落后 1.2m 再解除——0.6m 时转弯归队
                    # 的回摆路径还会蹭到障碍背面
                    self._ob_side.pop(oid, None)
                    continue
                side = self._ob_side.get(oid)
                if side is None:
                    # 让开侧优先选"队位所在的一侧"：转弯时队位参考航向还在
                    # 回转，按本机瞬时几何选侧曾把绿艇锁向桥墩封死段；
                    # 队位与障碍几乎共线（设计擦身工况）才退回瞬时几何。
                    # ⚠ 共线时"翼艇走外舷"试过——桥墙场景外舷=墙侧，翼艇
                    # 被推进墩排顶死（119 次接触），已回退；共线歧义由
                    # 场景侧规避（压线障碍偏离航线 ≥0.5m，见 编队演示.html）
                    slot_lat = None
                    if ref is not None:
                        e_lat = ex * (-st_o) + ey * ct_o   # 队位相对本机的横向
                        slot_lat = lat - e_lat             # 障碍相对队位的横向
                    if slot_lat is not None and abs(slot_lat) > 0.3:
                        side = -1.0 if slot_lat >= 0.0 else 1.0
                    else:
                        side = -1.0 if lat >= 0.0 else 1.0
                    self._ob_side[oid] = side
                deficit = (keep + FORM_OB_BUFFER) - (-lat * side)   # 锁定侧净距亏欠
                if deficit > -0.35:
                    ob_block.append(side)     # 贴边期间封锁归队回拉（见下）
                if deficit <= 0.0:
                    continue
                w = clamp(1.0 - s_al / FORM_OB_LOOKAHEAD, 0.0, 1.0)
                f = min(FORM_OB_MAX, FORM_OB_GAIN * deficit * (0.5 + 0.5 * w))
                obax += f * side * (-st_o)                # side·n̂（n̂ = 航向右法向）
                obay += f * side * ct_o
                ob_sum += f                               # 分量和（对消死锁检测用）
                if deficit > ob_best[0]:
                    ob_best = (deficit, f * side * (-st_o), f * side * ct_o)
                self._ob_evade = True
                # 亏欠仍大且已逼近：收前进分量，让横移跑在前面。
                # 动态目标（鱼）门限更宽：让位=先减速掉队再侧移，别跟受惊
                # 逃逸的鱼抢同一片水（追赶几何是翼艇擦鱼的根因之一）
                if is_dyn:
                    if deficit > 0.2 and -0.5 < s_al < 3.0:
                        ob_brake = min(ob_brake, FORM_OB_BRAKE)
                elif deficit > 0.4 and 0.0 < s_al < 2.2:
                    ob_brake = min(ob_brake, FORM_OB_BRAKE)
            # 边界滑行：让开后若立即撤力，归队拉力会把艇甩回禁区，航向滞后
            # (3.6s) 把这个继电振荡越摆越大（实测第二摆直接扎进礁石）。
            # 让位没过障碍前，把追踪/一致性项里"朝障碍侧"的分量清零——
            # 艇沿安全边界滑过，越过 (s_al<-1.2) 才释放归队
            for side_b in ob_block:
                bx = -side_b * (-st_o)
                by = -side_b * ct_o
                comp = pdx * bx + pdy * by
                if comp > 0.0:
                    pdx -= comp * bx
                    pdy -= comp * by
            # 对消死锁检测：两侧障碍的推力互相抵消（合力≪分量和）= 死缝
            # 几何（如桥墙相邻墩间 0.2m 缝）——被位移的艇曾在两墩间推力
            # 归零、直挺挺插进缝里顶死 114s。退化为"只听亏欠最大者 + 近停
            # 车"：慢速沿单侧爬出，绝不硬穿
            if ob_sum > 0.3 and math.hypot(obax, obay) < 0.4 * ob_sum:
                obax, obay = ob_best[1], ob_best[2]
                ob_brake = min(ob_brake, 0.25)

        # ⑤ 机间防撞斥力（全员，含领航者）+ 障碍斥力合并。避撞优先：斥力
        #    显著时收缩追踪/一致性项——否则饱和追踪(0.4)+前馈(0.42)碾过
        #    斥力上限，队形切换互扫时曾把 min_sep 压到 0.18m；障碍斥力
        #    同理要顶得住归队拉力
        ob_mag = math.hypot(obax, obay)
        cax, cay = obax, obay
        if collision_avoid is not None:
            cax += collision_avoid[0]
            cay += collision_avoid[1]
        ca_mag = math.hypot(cax, cay)
        yield_f = 1.0 - 0.6 * min(1.0, ca_mag / 0.4)
        vdx += yield_f * pdx + cax
        vdy += yield_f * pdy + cay

        # ---- 速度向量 → psi_d / u_d / base ----
        spd = math.hypot(vdx, vdy)
        if is_leader and ca_mag < 0.03:
            # 领航者无避让需求时不干扰 ILOS
            psi_d, u_d = base_psi, clamp(base_u, 0.05, FORM_U_MAX)
        elif spd < 0.10 or math.cos(wrap(math.atan2(vdy, vdx) - slot_psi)) < -0.2:
            # 期望速度近零或明显朝后（已越过队位且领航停/慢）：
            # 保持队形航向、零推力滑行减速，不许调头。
            # ⚠ 不能留 0.02+ 的爬行推力——窄道里前车被减速时，后车曾
            #   以 0.14m/s 稳态爬行顶上去（min_sep 0.004）
            # ⚠ 但障碍斥力显著时必须主动转向脱离——冻结航向的纯滑行会
            #   把斥力整个丢掉，绿艇曾被河流推着钉在桥墩上出不来
            if ob_mag > 0.08:
                psi_d = math.atan2(vdy, vdx)
                u_d = clamp(spd, 0.12, 0.20)
            else:
                psi_d, u_d = slot_psi, 0.0
        else:
            psi_d = math.atan2(vdy, vdx)
            u_d = clamp(spd, 0.05, FORM_U_MAX) * ob_brake

        # 油门：标定前馈 u_ss≈0.96·√base ⇒ base=(u/0.96)²，加速度伺服。
        # ⚠ 下限不能用 BASE_MIN(0.15)——那是单机保舵效的巡航下限，稳态
        #   0.37m/s；领航者在窄道里被威胁判定减速时，跟随者曾被这个下限
        #   顶着追尾。编队跟随必须能真正停车（下限 0 = 允许零推力滑行）。
        me_spd = math.hypot(me.get('vx', 0.0), me.get('vy', 0.0))
        base_cmd = clamp((u_d / 0.96) ** 2 + FORM_K_BU * (u_d - me_spd),
                         0.0, BASE_MAX)

        # ---- 深度期望 ----
        if is_leader:
            self.z_d = leader_z_d if leader_z_d is not None else self.z_d
        elif ref is not None:
            self.z_d = ref.get('z', self.z_d) + offsets[self.id][2] - ref_off[2]

        # ---- 编队误差（本机与期望队位的水平距离） ----
        if ref is not None and not is_leader:
            dx_exp = (ref['x'] + offsets[self.id][0] - ref_off[0]) - me['x']
            dy_exp = (ref['y'] + offsets[self.id][1] - ref_off[1]) - me['y']
            self.form_err = math.hypot(dx_exp, dy_exp)
        else:
            self.form_err = 0.0

        self.psi_d = wrap(psi_d)
        self.u_d = u_d
        self.base = base_cmd
        self.slow = 1.0
        self.state = 'TRANSIT'

        return {'psi_d': self.psi_d, 'u_d': self.u_d, 'z_d': self.z_d,
                'base': self.base, 'slow': self.slow, 'state': self.state,
                'form_err': self.form_err}

    # ---------- 辅助 ----------
    def debug(self):
        return {
            'id': self.id,
            'mode': self.mode,
            'formation': self._formation_name,
            'psi_d': round(self.psi_d, 3),
            'u_d': round(self.u_d, 3),
            'z_d': round(self.z_d, 3),
            'base': round(self.base, 3),
            'slow': round(self.slow, 3),
            'form_err': round(self.form_err, 3),
            'ob_evade': self._ob_evade,
            'slot_psi': round(self._slot_psi, 3) if self._slot_psi is not None else None,
            'offsets': [round(self.offsets[self.id][d], 2) for d in range(3)],
        }


# ============================================================
#  编队质量评估（全局）
# ============================================================
def formation_quality(fleet_state, offsets, virtual_leader=None, ref_psi=None):
    """计算编队 RMS 位置误差。

    ref_psi : float or None
        队位参考航向（建议传制导器的 slot_psi，与控制目标一致）；
        None 时退化用参考体实际航向。
    RMS 统计口径：leader-follower 模式下只统计跟随者（领航者误差恒 0，
    计入会稀释指标）；leaderless 模式统计全员。per_agent 仍全员返回。
    """
    n = len(fleet_state)
    errors = []
    if virtual_leader is not None:
        ref = virtual_leader
        count_from = 0
    else:
        ref = fleet_state[0] if fleet_state else None
        count_from = 1
    if ref is None:
        return {'rms': 0.0, 'per_agent': [0.0] * n}
    heading = ref_psi if ref_psi is not None else ref.get('psi', 0.0)
    c, s = math.cos(heading), math.sin(heading)
    ox0, oy0 = offsets[0][0], offsets[0][1]
    for i in range(n):
        st = fleet_state[i]
        if st is None:
            errors.append(0.0)
            continue
        ox, oy = offsets[i][0] - ox0, offsets[i][1] - oy0
        dx = (ref['x'] + c * ox - s * oy) - st['x']
        dy = (ref['y'] + s * ox + c * oy) - st['y']
        dz = (ref.get('z', 0) + offsets[i][2]) - st.get('z', 0)
        errors.append(math.hypot(dx, dy, dz))
    stat = errors[count_from:] if len(errors) > count_from else errors
    rms = math.sqrt(sum(e * e for e in stat) / max(1, len(stat)))
    return {'rms': rms, 'per_agent': errors}


# ============================================================
#  机间防撞（每对 agent 之间的斥力，速度量纲，全员适用）
# ============================================================
def inter_agent_collision_avoidance(fleet_state, collision_r=None):
    """计算每个 agent 的机间防撞速度修正项。

    斥力 f = FORM_K_CA·(r_safe - d)/max(d, 0.15)，单对上限 FORM_CA_MAX，
    方向 = 远离对方；对称作用于双方（含领航者——v1 领航者不避让是
    近距事故的另一半原因）。
    """
    n = len(fleet_state)
    r_safe = collision_r if collision_r is not None else FORM_COLLISION_R
    corrections = [(0.0, 0.0) for _ in range(n)]
    for i in range(n):
        si = fleet_state[i]
        if si is None:
            continue
        for j in range(i + 1, n):
            sj = fleet_state[j]
            if sj is None:
                continue
            dx = si['x'] - sj['x']
            dy = si['y'] - sj['y']
            d = math.hypot(dx, dy)
            if d < r_safe and d > 0.01:
                f = min(FORM_CA_MAX, FORM_K_CA * (r_safe - d) / max(d, 0.15))
                # 近接硬提升：0.7m 内斥力线性拔到 2.4——机间避撞的优先级必须
                # 凌驾 O8 让位/追踪/前馈的合力（≈1.3）。曾靠 0.8 上限：绿艇
                # 被 O8 朝领航侧推、两力对消后以 0.04m 机距穿过领航艇
                if d < 0.7:
                    f = max(f, 0.8 + 1.6 * (0.7 - d) / 0.7)
                fx = f * dx / d
                fy = f * dy / d
                ax_i, ay_i = corrections[i]
                ax_j, ay_j = corrections[j]
                corrections[i] = (ax_i + fx, ay_i + fy)
                corrections[j] = (ax_j - fx, ay_j - fy)
    return corrections
