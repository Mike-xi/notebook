# coding: utf-8
"""
multi_sim_entry —— 蛟人核心的多机编队仿真接线层（阶段三）
=========================================================
同一份 Lib 算法三处可用：

① 编队演示.html（Pyodide 直载）：经典 multi_update() 约定
     multi_reset(env) / multi_update(states_json, env_json, dt) → JSON

② 桌面 Python 直接跑：FleetEngine 干跑全航点（本文件 __main__）

③ 实物扩展：每台树莓派各自运行 JiaoRen.py + FormationController，
    通过 UDP/WiFi 广播自身状态、接收邻居状态即可实现分布式编队；
    本文件中的 FleetEngine 是仿真集中式替代（一进程跑 N 机）。

设计要点：
  * 每个 agent 拥有独立的 StateEstimator / VisionTracker / Controller
  * Agent 0（领航者）跑 ILOS 航点跟踪（复用 Guidance.Mission）
  * 其余 agent 跑一致性编队协议（Formation.FormationController）
  * 通信拓扑控制邻居可见性（模拟分布式约束）
  * 支持模式切换：leader-follower ↔ leaderless
  * 支持队形切换 + agent 失效/恢复
"""
import json
import math
import random
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from Lib.Params import *
from Lib.StateEstimation import StateEstimator
from Lib.Vision import VisionTracker
from Lib.Guidance import Mission
from Lib.Control import Controller
from Lib.Formation import (FormationController, FormationTopology,
                           formation_quality, inter_agent_collision_avoidance,
                           BUILTIN_FORMATIONS)

NAME = "蛟人核心·阶段三（多机一致性编队）"

# 事件播报里的艇名——与 编队演示.html 的配色顺序一致（0橙=领航/1绿/2蓝）
AGENT_CN = ('领航艇', '绿艇', '蓝艇')
FORM_CN = {'triangle': '三角编队', 'line': '一字横队',
           'column': '一字纵队', 'diamond': '菱形编队',
           'gate_column': '窄道纵队'}


# ============================================================
#  FleetEngine —— N 机编队仿真引擎
# ============================================================
class FleetEngine:
    """集中式多机仿真引擎（每个 agent 仍保持独立的感知-决策-控制链路，
    仅通过通信拓扑限制信息共享，模拟分布式约束）。"""

    def __init__(self, waypoints, n=3, formation='triangle', mode='leader-follower',
                 width=20.0, start=(3, 10, 0.5, 0), loop=False):
        self.n = n
        self.mode = mode
        self._mode0 = mode
        self.width = width
        self.start_pose = start
        self.waypoints = [list(w) for w in waypoints]
        self.loop = loop

        # O8 队形自适应监督器：用户偏好队形 + 窄道强制纵队状态
        self._pref_formation = formation if isinstance(formation, str) else 'custom'
        self._gate_hold = False
        self._gate_obs = []          # 触发窄道的障碍快照 [(x, y, r), ...]
        self._events = []            # 舰队级事件（监督器/安全层播报）
        self._evade_prev = [False] * n
        self._evade_t = [-9.0] * n   # 各艇上次避让播报时刻（冷却用）

        # 通信拓扑
        self.topology = FormationTopology(n, 'full')

        # 每个 agent 的子模块
        self.est = [StateEstimator() for _ in range(n)]
        self.vision = [VisionTracker() for _ in range(n)]
        self.ctrl = [Controller() for _ in range(n)]

        # 编队控制器（每个 agent 一个）
        self.form = [FormationController(i, n, formation, mode) for i in range(n)]

        # 领航者的 ILOS 制导（仅 agent 0，leaderless 模式下用作虚拟领航者 ILOS）
        self.mission = Mission(self.waypoints, width=width,
                               start_z=start[2], loop=loop,
                               et_lim=min(ET_LIM, 0.32 * width))

        # 无领航模式下的虚拟领航者 ILOS（独立于任何物理 agent）
        self._virt_est = StateEstimator()
        self._virt_mission = Mission(self.waypoints, width=width,
                                     start_z=start[2], loop=loop,
                                     et_lim=min(ET_LIM, 0.32 * width))
        self._virt_mission_started = False

        # 仿真时间
        self.t = 0.0
        self._next_dec = 0.0

        # 领航者失效模拟
        self._leader_fail = False
        self._leader_last_seen = 0.0

        # 通信丢包（Gilbert-Elliott 突发模型，默认关闭）
        self._loss_rate = 0.0
        self._ge_p = self._ge_r = 0.0
        self._ge_rng = random.Random(1)
        self._ge_state = {}

        self.reset()

    def reset(self):
        x0, y0, z0, psi0 = self.start_pose
        # 复位到初始模式与偏好队形（重新演示时不残留 leaderless/强制纵队）
        self.mode = self._mode0
        self._gate_hold = False
        self._gate_obs = []
        self._events = []
        self._evade_prev = [False] * self.n
        self._evade_t = [-9.0] * self.n
        self.form = [FormationController(i, self.n, self._pref_formation, self.mode)
                     for i in range(self.n)]
        for i in range(self.n):
            off = self.form[i].offsets[i] if i < len(self.form[i].offsets) else [0, 0, 0]
            self.est[i].reset(x0 + off[0], y0 + off[1], z0 + off[2], psi0)
            self.vision[i].reset()
            self.ctrl[i].reset()
            self.form[i].psi_d = psi0
            self.form[i].z_d = z0
        self.mission.reset(x0, y0)
        self._virt_est.reset(x0, y0, z0, psi0)
        self._virt_mission.reset(x0, y0)
        self._virt_mission_started = False
        self._virt_psi = psi0
        self.t = 0.0
        self._next_dec = 0.0
        self._leader_fail = False
        self._leader_last_seen = 0.0
        self.topology = FormationTopology(self.n, 'full')
        self._ge_state = {}   # 丢包链复位（丢包率配置保留）

    def start(self):
        self.mission.start(self.est[0])
        self._virt_mission.start(self._virt_est)
        self._virt_mission.pop_events()   # 虚拟任务的"任务开始"不重复播报
        self._virt_mission_started = True

    # ---------- 一个控制拍的全体 step ----------
    def step(self, all_imu, all_depth, all_vo, all_dets, t, dt):
        """每个控制拍（100Hz）调用一次。

        Parameters
        ----------
        all_imu : list of dict or None  (每机 IMU 数据)
        all_depth : list of dict or None
        all_vo : list of dict or None
        all_dets : list of list or None    (每机视觉检测)
        t, dt : float

        Returns
        -------
        list of tuple : [(nL, nR, delta, s_cmd), ...]  每机执行器指令
        """
        self.t = t

        # 1) 状态估计（每机独立融合传感器）
        for i in range(self.n):
            imu = all_imu[i] if all_imu and i < len(all_imu) else None
            dep = all_depth[i] if all_depth and i < len(all_depth) else None
            vo = all_vo[i] if all_vo and i < len(all_vo) else None
            self.est[i].update(imu, dep, vo, dt)

        # 2) 视觉跟踪（每机独立，有检测帧时运行）
        for i in range(self.n):
            dets = all_dets[i] if all_dets and i < len(all_dets) and all_dets[i] else None
            if dets is not None:
                self.vision[i].tick(dets, self.est[i], t, 1.0 / RATE_VISION)

        # 3) 决策层（RATE_DECIDE Hz）
        if t >= self._next_dec:
            dt_d = 1.0 / RATE_DECIDE
            self._next_dec = t + dt_d

            # ---- 构建舰队状态（通信拓扑过滤） ----
            fleet_state = []
            for i in range(self.n):
                e = self.est[i]
                cps, sps = math.cos(e.psi), math.sin(e.psi)
                fleet_state.append({
                    'id': i, 'x': e.x, 'y': e.y, 'z': e.z,
                    'psi': e.psi, 'vx': e.vx, 'vy': e.vy,
                    'u': e.vx * cps + e.vy * sps,
                    'v': -e.vx * sps + e.vy * cps,
                    'zdot': e.zdot,
                })

            # 模拟通信拓扑：未被连通的 agent 在邻居视角为 None；
            # 连通链路再过 Gilbert-Elliott 突发丢包（每有向链路独立）
            visible = []
            for i in range(self.n):
                neighbors = self.topology.neighbors_of(i)
                vi = {}
                for j in range(self.n):
                    if j == i:
                        vi[j] = fleet_state[j]
                    elif j in neighbors and not self._link_lost(i, j):
                        vi[j] = fleet_state[j]
                    else:
                        vi[j] = None
                visible.append(vi)

            # 机间防撞修正（基于真实状态，但只在 agent 能“感知”到对方时生效——
            # 这里简化为全状态感知防撞；实物中可用机载视觉/声呐测距实现）
            ca = inter_agent_collision_avoidance(fleet_state)

            # ---- 领航者失效检测 ----
            if self._leader_fail:
                for i in range(1, self.n):
                    visible[i][0] = None
                visible[0] = {j: (fleet_state[j] if j == 0 else None) for j in range(self.n)}

            # ---- 各机的障碍轨迹（O8 编队安全层输入，本机视觉各看各的）：
            #      静态礁石/桥墩/立柱 + 动态全水深大鱼都放行（Formation 内
            #      对动态目标做速度前推）；浅吃水目标不进安全层 ----
            obs = [[tr for tr in self.vision[i].confirmed()
                    if tr.full] for i in range(self.n)]

            # ---- 各 agent 制导/编队决策 ----
            leader_psi_d = None
            leader_u_d = None
            leader_z_d = None
            virtual_leader = None

            if self.mode == 'leader-follower' and not self._leader_fail:
                # Agent 0 = 领航者：ILOS 航点跟踪。
                # 窄道保持期间过滤掉触发窄道的障碍——监督器已接管通过方案
                # （纵队走门中央）；不滤的话，门间隔(±0.3m)在噪声下会被
                # Mission 判成约束冲突 → "从全部障碍外侧绕" → 一头扎向
                # 桥的封死段（实测领航艇被引到 y=3 的 0.4m 墩缝里）
                self.mission.tick(self._filter_gate_tracks(
                    self.vision[0].confirmed()), self.est[0], dt_d)
                leader_psi_d = self.mission.psi_d
                leader_u_d = U_DES * self.mission.slow
                leader_z_d = self.mission.zref
                leg_psi = self._leg_tangent(self.mission)

                # O8 队形自适应：前方通道装不下当前队形 → 自动收纵队
                self._formation_supervisor(self.est[0].x, self.est[0].y, leg_psi,
                                           leg_remain=self._leg_remain(
                                               self.mission, self.est[0]),
                                           wp_xy=self._wp_xy(self.mission))

                # 领航者也过 compute：航向直通 ILOS、地速伺服到 U_DES（留出
                # 跟随者 0.89-0.42≈0.47m/s 的追赶余量，v1 领航 base 0.55 实跑
                # 0.71m/s 几乎顶满跟随者极限，转弯队位扫掠必然甩队）；
                # 防撞斥力显著时并入避让
                self.form[0].compute(visible[0], t, dt_d,
                                     leader_psi_d, leader_u_d, leader_z_d,
                                     collision_avoid=ca[0], slot_psi_ref=leg_psi)

                # 跟随者：一致性编队（队位参考航向=航段切向，
                # 不随领航者 ILOS 收线的 psi_d 振荡扫摆）
                for i in range(1, self.n):
                    self.form[i].compute(visible[i], t, dt_d,
                                         leader_psi_d, leader_u_d, leader_z_d,
                                         collision_avoid=ca[i], slot_psi_ref=leg_psi,
                                         obstacles=obs[i])
            else:
                # 无领航一致性模式（或领航失效后自动切换）
                # 虚拟领航者走 ILOS；编队形心掉队时减速等待（反馈调速，
                # v1 虚拟点纯运动学前进，编队追不上它就丢了）
                v_u = 0.0
                if self._virt_mission_started and self._virt_mission.state != 'DONE':
                    alive_ids = [i for i in range(self.n)
                                 if i not in self.topology._dropped]
                    alive = [self.est[i] for i in alive_ids]
                    gov = 1.0
                    if alive:
                        cx = sum(e.x for e in alive) / len(alive)
                        cy = sum(e.y for e in alive) / len(alive)
                        lag = math.hypot(self._virt_est.x - cx, self._virt_est.y - cy)
                        gov = clamp(1.0 - (lag - FORM_GOV_DIST) / 1.5, 0.2, 1.0)
                    # 虚拟领航者吃中继机（最小编号存活艇）的障碍轨迹做规避——
                    # 否则无领航阶段撞上障碍只能靠个体斥力硬扛
                    relay_tracks = (self._filter_gate_tracks(
                        self.vision[alive_ids[0]].confirmed())
                        if alive_ids else [])
                    self._virt_mission.tick(relay_tracks, self._virt_est, dt_d)
                    # 虚拟点无动力学，psi_d 在航点切换时瞬跳会让前馈速度
                    # 向量甩鞭——限速率平滑（与实艇转向能力同量级）
                    step = clamp(wrap(self._virt_mission.psi_d - self._virt_psi),
                                 -0.30 * dt_d, 0.30 * dt_d)
                    self._virt_psi = wrap(self._virt_psi + step)
                    v_psi = self._virt_psi
                    v_u = U_DES * self._virt_mission.slow * gov
                    self._virt_est.x += v_u * math.cos(v_psi) * dt_d
                    self._virt_est.y += v_u * math.sin(v_psi) * dt_d
                    self._virt_est.z = self._virt_mission.zref
                    self._virt_est.psi = v_psi
                    self._virt_est.vx = v_u * math.cos(v_psi)
                    self._virt_est.vy = v_u * math.sin(v_psi)

                virtual_leader = {
                    'id': -1, 'x': self._virt_est.x, 'y': self._virt_est.y,
                    'z': self._virt_est.z, 'psi': self._virt_est.psi,
                    'u': v_u, 'v': 0.0, 'zdot': 0.0,
                    'vx': self._virt_est.vx, 'vy': self._virt_est.vy,
                }

                leg_psi_v = self._leg_tangent(self._virt_mission)
                self._formation_supervisor(self._virt_est.x, self._virt_est.y,
                                           leg_psi_v,
                                           leg_remain=self._leg_remain(
                                               self._virt_mission, self._virt_est),
                                           wp_xy=self._wp_xy(self._virt_mission))
                for i in range(self.n):
                    # 掉线艇收不到虚拟领航共识 → 保持原期望直航（可见的失效表现）
                    vl_i = (None if i in self.topology._dropped
                            else virtual_leader)
                    self.form[i].compute(visible[i], t, dt_d,
                                         virtual_leader=vl_i,
                                         collision_avoid=ca[i],
                                         slot_psi_ref=leg_psi_v,
                                         obstacles=obs[i])

            # ---- O8 安全层事件播报（上升沿 + 5s 冷却，防边界抖动刷屏） ----
            for i in range(self.n):
                ev = self.form[i]._ob_evade
                if ev and not self._evade_prev[i] and t - self._evade_t[i] > 5.0:
                    self._events.append('🛟 %s 队位受障碍侵占，局部让位绕行'
                                        % AGENT_CN[min(i, len(AGENT_CN) - 1)])
                if ev:
                    self._evade_t[i] = t
                self._evade_prev[i] = ev

        # 4) 控制层（每机独立）
        cmds = []
        for i in range(self.n):
            fc = self.form[i]
            # 构造一个与 Controller.tick 兼容的 mission 对象
            class _FormMission:
                state = fc.state
                psi_d = fc.psi_d
                zref = fc.z_d
                base = fc.base
                slow = fc.slow

            fm = _FormMission()
            cmd = self.ctrl[i].tick(self.est[i], fm, dt)
            cmds.append(cmd)

        return cmds

    # ---------- 通信丢包（Gilbert-Elliott 突发模型） ----------
    def set_link_loss(self, rate, burst_len=10.0, seed=1):
        """设置链路丢包。

        rate : 平均丢包率 ρ ∈ [0, 0.95]（B 态平稳概率）
        burst_len : 平均突发长度 [决策拍]（20Hz 下 10 拍 = 0.5s 连续丢失）
        seed : 随机种子（实验可复现）

        两态马尔可夫链：G(收到)/B(丢失)，r = 1/burst_len，
        p = ρ·r/(1-ρ)，平稳分布 P(B) = p/(p+r) = ρ。
        """
        self._loss_rate = clamp(float(rate), 0.0, 0.95)
        burst = max(1.0, float(burst_len))
        self._ge_r = 1.0 / burst
        self._ge_p = (self._loss_rate * self._ge_r / (1.0 - self._loss_rate)
                      if self._loss_rate > 0 else 0.0)
        self._ge_rng = random.Random(seed)
        self._ge_state = {}

    def _link_lost(self, i, j):
        """推进链路 (j→i) 的 GE 链一拍，返回本拍是否丢包。"""
        if self._loss_rate <= 0.0:
            return False
        st = self._ge_state.get((i, j), 'G')
        if st == 'G':
            if self._ge_rng.random() < self._ge_p:
                st = 'B'
        else:
            if self._ge_rng.random() < self._ge_r:
                st = 'G'
        self._ge_state[(i, j)] = st
        return st == 'B'

    @staticmethod
    def _leg_remain(mission, est):
        """到当前航点的剩余距离（供监督器截断本航段外的障碍）。"""
        try:
            if mission.state == 'DONE' or mission.wp_i >= len(mission.wps):
                return None
            wp = mission.wps[mission.wp_i]
            return math.hypot(wp[0] - est.x, wp[1] - est.y)
        except (AttributeError, IndexError):
            return None

    @staticmethod
    def _leg_tangent(mission):
        """当前航段切向（分段常值的队位参考航向）；任务结束/未启动返回 None。"""
        try:
            if mission.state == 'DONE' or mission.wp_i >= len(mission.wps):
                return None
            wp = mission.wps[mission.wp_i]
            dx = wp[0] - mission.leg_from[0]
            dy = wp[1] - mission.leg_from[1]
            if abs(dx) < 1e-9 and abs(dy) < 1e-9:
                return None
            return math.atan2(dy, dx)
        except (AttributeError, IndexError):
            return None

    # ---------- O8 队形自适应监督器 ----------
    def _filter_gate_tracks(self, tracks):
        """窄道保持期间，把触发窄道的障碍从 Mission 威胁输入中剔除。"""
        if not self._gate_hold or not self._gate_obs:
            return tracks
        return [tr for tr in tracks
                if not (getattr(tr, 'static', False) and getattr(tr, 'full', False)
                        and any(math.hypot(tr.x - ox, tr.y - oy) < 1.0
                                for (ox, oy, _r) in self._gate_obs))]

    def _fleet_half_width(self, formation):
        """队形横向半宽 [m]（体系 y 偏移最大绝对值）。"""
        offs = formation if isinstance(formation, list) else \
            BUILTIN_FORMATIONS.get(formation, BUILTIN_FORMATIONS['triangle'])
        return max(abs(o[1]) for o in offs[:self.n])

    @staticmethod
    def _wp_xy(mission):
        """当前航点坐标（监督器横向基准用）；任务结束/未启动返回 None。"""
        try:
            if mission.state == 'DONE' or mission.wp_i >= len(mission.wps):
                return None
            w = mission.wps[mission.wp_i]
            return (w[0], w[1])
        except (AttributeError, IndexError):
            return None

    def _formation_supervisor(self, rx, ry, leg_psi, leg_remain=None,
                              wp_xy=None):
        """窄道自适应：前方两侧障碍夹出的通道净宽装不下当前队形 → 自动收
        纵队；全队（存活艇）越过触发障碍 FORM_GATE_CLEAR 米后恢复偏好队形。

        判定要点：①必须**两侧同时受限**才算窄道——单侧障碍由领航者 Mission
        的横向偏移线整体绕行（队形随动即可），收队形反而丢搜索宽度；
        ②只评估**当前航段**内的障碍（leg_remain+2m 截断）——转弯前航段
        延长线可能斜插进障碍群，斜坐标系里会算出假窄道，且转弯叠加变
        队形互扫曾把最小机距压到 0.23m；
        ③横向坐标以**航段线**（过当前航点、沿航段切向）为基准，不以领航
        艇当前位置为基准——领航艇被大鱼横向压出 2.5m 时，曾从偏移视角把
        两颗散石误判成 3.6m 窄道；
        ④通道净宽连**单艇**都装不下（< 2×(0.28+FORM_GATE_MARGIN)）不算
        门，那是封路——必须交给 Mission 走廊绕行。曾把正压航线的礁石当
        "门柱"从 Mission 输入里滤掉，领航艇对石盲开被顶死 130s。
        """
        if leg_psi is None:
            return
        ct, st = math.cos(leg_psi), math.sin(leg_psi)
        alive = [i for i in range(self.n) if i not in self.topology._dropped]

        if not self._gate_hold:
            # 模式切换（掉线接管/恢复归建）后 3s 静默：过渡拍的任务进度/航段
            # 基准不可靠（虚拟任务 wp 未同步时 wps[wp_i-1] 负索引会造出
            # "WP5→WP1"伪航段），接管拍曾据此再配一次 2.5m 假门
            if self.t - getattr(self, '_mode_switch_t', -9.0) < 3.0:
                return
            half_need = (self._fleet_half_width(self._pref_formation)
                         + 0.28 + FORM_GATE_MARGIN)     # 0.28 ≈ 艇外接半径
            if half_need <= 0.28 + FORM_GATE_MARGIN + 1e-6:
                return                                   # 偏好已是纵队
            s_cap = FORM_GATE_LOOKAHEAD
            if leg_remain is not None:
                s_cap = min(s_cap, leg_remain + 2.0)
            # 航段线参考点 = **真实航点坐标**，横向基准与领航艇瞬时偏移解耦。
            # ⚠ 曾用 rx+leg_remain·t̂ 当参考点——横向分量上与直接用领航位置
            # 数学等价（t̂ 项在求 lat 时消掉），是个无效修正：领航被航段5
            # 压线石推出 -1.6m 时，景观石(lat -3.6)滑进窗口与压线石配成
            # 2.9m 假门 → Mission 被致盲 → 领航顶死在压线石上（col 24/25）。
            # 拿不到航点坐标（如失联接管的过渡拍，虚拟任务尚未就绪）就跳过
            # 本拍判定——回退基准必然被位移污染，接管拍曾再配一次假门
            if wp_xy is None:
                return
            wx, wy = wp_xy
            lat_win = half_need + 1.0    # 横向搜索窗：队宽外 1m 即无关（曾用
                                         # ±4m，把 4.3m 外的翼侧石也拉进判定）
            gap_lo, gap_hi = -lat_win, lat_win
            gate = []
            bound_l = bound_r = False
            s_l = s_r = None             # 左右"门柱"的沿航向位置
            bind_l = bind_r = None       # 左右门柱坐标（事件诊断用）
            for i in alive:
                for tr in self.vision[i].confirmed():
                    if not (tr.static and tr.full):
                        continue
                    s = (tr.x - rx) * ct + (tr.y - ry) * st
                    lat = -(tr.x - wx) * st + (tr.y - wy) * ct
                    if s < 0.5 or s > s_cap or abs(lat) > lat_win:
                        continue
                    if lat >= 0.0:
                        if lat - tr.r < gap_hi:
                            gap_hi = lat - tr.r
                            s_r = s
                            bind_r = (tr.x, tr.y)
                        bound_r = True
                    else:
                        if lat + tr.r > gap_lo:
                            gap_lo = lat + tr.r
                            s_l = s
                            bind_l = (tr.x, tr.y)
                        bound_l = True
                    gate.append((tr.x, tr.y, tr.r))
            # 沿航向一致性：左右门柱 |Δs|≤3m 才是"一扇门"（桥墩同列 Δs≈0）。
            # 曾把相距 8m 的两颗散石夹成 4.0m 假门 → 收纵队+Mission 被致盲
            # 擦石 → 释放条件挂在远端石上 60s 超时
            coherent = (s_l is not None and s_r is not None
                        and abs(s_r - s_l) <= 3.0)
            # ⑤ 门必须**跨骑航线**（gap_lo<-0.2 且 gap_hi>+0.2）：用户把警示柱
            # 拖到航线正中（lat≈0）时，柱子曾被当成"左门柱"与 2.3m 外的翼石
            # 拼出净宽 1.5m 的"门"——通道整个在航线一侧，走这门本身就要横移
            # 1.2m，这是"障碍挡路+侧方有空当"= Mission 走廊的活；致盲后领航
            # 艇曾对柱盲开怼上去
            if (bound_l and bound_r and coherent
                    and gap_lo < -0.2 and gap_hi > 0.2
                    and (gap_hi - gap_lo) >= 2.0 * (0.28 + FORM_GATE_MARGIN)
                    and (gap_hi - gap_lo) / 2.0 < half_need):
                self._gate_hold = True
                self._gate_obs = gate
                self._gate_t0 = self.t
                for i in range(self.n):
                    self.form[i].set_formation('gate_column', self.t)
                self._events.append(
                    '⤵ 前方通道净宽 %.1f m ＜ %s所需 %.1f m —— 自动收拢为纵队'
                    '<span style="opacity:.55">（门柱 L(%.1f,%.1f) R(%.1f,%.1f)）</span>'
                    % (max(gap_hi - gap_lo, 0.0),
                       FORM_CN.get(self._pref_formation, '当前队形'),
                       2 * half_need,
                       bind_l[0], bind_l[1], bind_r[0], bind_r[1]))
        else:
            # 全部存活艇越过全部触发障碍 + 裕量 → 恢复；
            # 看门狗：保持超时（有艇被卡/被拖走障碍缠住）也强制恢复。
            # "越过"= 障碍在艇后(s<0) 且 欧氏距离 > r+CLEAR——曾用纯切向投影
            # 判据：过 WP3 转弯后坐标轴旋转 42°，门墩在新轴上的投影迟迟不够
            # 负，纵队被拖到 x≈30 才释放，撞上 WP4 转弯+失联注入（机距 0.19）
            timeout = self.t - getattr(self, '_gate_t0', self.t) > 60.0
            if not timeout:
                for (ox, oy, orr) in self._gate_obs:
                    for i in alive:
                        e = self.est[i]
                        s = (ox - e.x) * ct + (oy - e.y) * st
                        if (s > 0.0 or math.hypot(ox - e.x, oy - e.y)
                                < orr + FORM_GATE_CLEAR):
                            return
            self._gate_hold = False
            self._gate_obs = []
            for i in range(self.n):
                self.form[i].set_formation(self._pref_formation, self.t)
            self._events.append(('⚠ 窄道通过超时，恢复%s' if timeout
                                 else '⤴ 全队通过窄道，恢复%s展开')
                                % FORM_CN.get(self._pref_formation, '偏好队形'))

    # ---------- 操作接口 ----------
    def switch_formation(self, name):
        """切换编队队形（所有 agent 同步切换；窄道强制纵队期间只记偏好）。"""
        self._pref_formation = name if isinstance(name, str) else 'custom'
        if self._gate_hold:
            self._events.append('⏸ 窄道通过中，%s 将在通过后生效'
                                % FORM_CN.get(self._pref_formation, str(name)))
            return
        for i in range(self.n):
            self.form[i].set_formation(name, self.t)

    def switch_mode(self, mode):
        """切换编队模式：'leader-follower' ↔ 'leaderless'。

        切换时**同步任务进度**：Mission.start 会复位到第 0 航点，不同步的话
        编队会掉头回跑整条航线（实测领航失效场景 peak 7.3m、耗时 172s）。
        """
        if mode == self.mode:
            return
        self.mode = mode
        self._mode_switch_t = self.t   # 监督器窄道判定静默期起点
        if mode == 'leaderless':
            # 初始化虚拟领航者（承接领航者的位置与任务进度）
            self._virt_est.reset(self.est[0].x, self.est[0].y,
                                 self.est[0].z, self.est[0].psi)
            self._virt_mission.start(self._virt_est)
            self._virt_mission.pop_events()   # 接管不重播"任务开始"
            # 无条件同步任务进度（曾只在 TRANSIT/DONE 同步：其他状态下虚拟
            # 任务留在 wp_i=0，负索引伪航段见 _leg_tangent 注释）
            self._virt_mission.wp_i = min(self.mission.wp_i,
                                          len(self._virt_mission.wps) - 1)
            self._virt_mission.leg_from = [self._virt_est.x, self._virt_est.y]
            if self.mission.state == 'DONE':
                self._virt_mission.state = 'DONE'
            self._virt_psi = self.est[0].psi
            self._virt_mission_started = True
        else:
            # 切回领航模式：真实 Mission 在无领航期间没有推进，从虚拟任务接棒
            if self._virt_mission_started and self.mission.state == 'TRANSIT':
                self.mission.wp_i = min(self._virt_mission.wp_i,
                                        len(self.mission.wps) - 1)
                self.mission.leg_from = [self.est[0].x, self.est[0].y]
                self.mission.e_int = 0.0
                if self._virt_mission.state == 'DONE':
                    self.mission.state = 'DONE'
        for i in range(self.n):
            self.form[i].mode = mode

    def drop_agent(self, agent_id):
        """模拟 agent 通信掉线。"""
        self.topology.drop(agent_id)
        if agent_id == 0:
            self._leader_fail = True
            self._leader_last_seen = self.t
            self.switch_mode('leaderless')

    def restore_agent(self, agent_id):
        """恢复 agent 通信。"""
        self.topology.restore(agent_id)
        if agent_id == 0:
            self._leader_fail = False

    def switch_topology(self, pattern):
        """切换通信拓扑。"""
        self.topology.switch(pattern)

    # ---------- 调试/监控 ----------
    def fleet_state_dict(self):
        """返回所有 agent 的估计状态（供 HUD / 制导显示）。"""
        return [e.as_dict() for e in self.est]

    def virtual_leader_dict(self):
        """返回虚拟领航者状态（无领航模式）。"""
        return {
            'x': self._virt_est.x, 'y': self._virt_est.y, 'z': self._virt_est.z,
            'psi': self._virt_est.psi, 'u': self._virt_est.vx,
        }

    def debug(self):
        """完整调试快照（供网页 HUD 渲染）。"""
        fs = self.fleet_state_dict()
        vl = self.virtual_leader_dict() if self.mode == 'leaderless' or self._leader_fail else None
        # 用制导器的平滑队位航向评估队形（与控制目标一致；转弯时不因
        # 参考体瞬时艏向抖动虚报误差）
        slot_psi = None
        for fc in self.form[1:] + self.form[:1]:
            if fc._slot_psi is not None:
                slot_psi = fc._slot_psi
                break
        quality = formation_quality(fs, self.form[0].offsets,
                                    virtual_leader=vl, ref_psi=slot_psi)
        # 无领航阶段任务进度由虚拟领航者的 Mission 推进
        act = self._virt_mission if (self.mode == 'leaderless'
                                     and self._virt_mission_started) else self.mission
        return {
            't': round(self.t, 2),
            'mode': self.mode,
            'leader_fail': self._leader_fail,
            'formation': {
                'name': self.form[0]._formation_name if self.form else '?',
                'pref': self._pref_formation,
                'gate_hold': self._gate_hold,
                'rms': round(quality['rms'], 3),
                'per_agent': [round(e, 3) for e in quality['per_agent']],
                'evade': [bool(fc._ob_evade) for fc in self.form],
            },
            'topology': {**self.topology.summary(),
                         'loss_rate': self._loss_rate},
            'mission': {
                'state': act.state,
                'wp_i': act.wp_i,
                'n_wp': len(act.wps),
                'psi_d': round(act.psi_d, 3),
                'zref': round(act.zref, 3),
                'e': round(act.e, 3),
            },
            'virtual_leader': vl,
            'agents': [{
                'id': i,
                'est': {k: round(v, 3) for k, v in fs[i].items()},
                'form': self.form[i].debug(),
                'cmd': [round(v, 3) for v in
                        self.ctrl[i].out] if hasattr(self.ctrl[i], 'out') else [],
            } for i in range(self.n)],
            'events': [],
        }

    def pop_events(self):
        events, self._events = self._events, []
        # 视觉播报只取领航艇（三机各报一遍会刷屏）
        events.extend(self.vision[0].pop_events())
        for i in range(1, self.n):
            self.vision[i].pop_events()
        events.extend(self.mission.pop_events())
        events.extend(self._virt_mission.pop_events())
        return events


# ============================================================
#  JSON API —— 供编队演示.html 调用（与 sim_entry.py 相同模式）
# ============================================================
_FLEET = None


def fleet_init(cfg_json):
    """编队演示.html 调用：初始化 FleetEngine。

    cfg_json 字段：
        waypoints, n(默认3), formation(默认'triangle'),
        mode('leader-follower'|'leaderless'), width, start
    """
    global _FLEET
    cfg = json.loads(cfg_json) if isinstance(cfg_json, str) else cfg_json
    _FLEET = FleetEngine(
        waypoints=cfg['waypoints'],
        n=cfg.get('n', FORM_N_AGENTS),
        formation=cfg.get('formation', 'triangle'),
        mode=cfg.get('mode', 'leader-follower'),
        width=cfg.get('width', 20.0),
        start=tuple(cfg.get('start', (3, 10, 0.5, 0))),
        loop=cfg.get('loop', False),
    )
    return NAME


def fleet_start():
    if _FLEET:
        _FLEET.start()


def fleet_reset():
    if _FLEET:
        _FLEET.reset()


def fleet_step(inp_json):
    """编队演示.html 每控制拍（100Hz）调用。

    输入 JSON：
        { t, dt,
          all_imu: [{yaw,pitch,q,r}, ...],
          all_depth: [{depth}, ...],
          all_vo: [{x,y,vx,vy}, ...],
          all_dets: [[{rg,brg,type,r,draft,full}, ...], ...] }
    返回 JSON：
        { cmds: [[nL,nR,delta,sCmd], ...],
          debug: {...},
          events: [...] }
    """
    global _FLEET
    if _FLEET is None:
        return json.dumps({'cmds': [[0, 0, 0, 0.5]] * 3, 'debug': {}, 'events': []})
    inp = json.loads(inp_json) if isinstance(inp_json, str) else inp_json
    cmds = _FLEET.step(
        inp.get('all_imu'), inp.get('all_depth'),
        inp.get('all_vo'), inp.get('all_dets'),
        inp['t'], inp['dt'],
    )
    return json.dumps({
        'cmds': [list(c) for c in cmds],
        'debug': _FLEET.debug(),
        'events': _FLEET.pop_events(),
    }, ensure_ascii=False)


def fleet_switch_formation(name):
    if _FLEET:
        _FLEET.switch_formation(name)
        return f'队形切换至 {name}'


def fleet_switch_mode(mode):
    if _FLEET:
        _FLEET.switch_mode(mode)
        return f'模式切换至 {mode}'


def fleet_drop_agent(agent_id):
    if _FLEET:
        _FLEET.drop_agent(agent_id)
        return f'Agent {agent_id} 通信掉线'


def fleet_restore_agent(agent_id):
    if _FLEET:
        _FLEET.restore_agent(agent_id)
        return f'Agent {agent_id} 通信恢复'


def fleet_switch_topology(pattern):
    if _FLEET:
        _FLEET.switch_topology(pattern)
        return f'拓扑切换至 {pattern}'


def fleet_set_link_loss(rate, burst_len=10.0, seed=1):
    if _FLEET:
        _FLEET.set_link_loss(rate, burst_len, seed)
        return f'链路丢包率 {float(rate) * 100:.0f}%（突发长度 {burst_len} 拍）'


# ============================================================
#  桌面闭环自检：py -3 multi_sim_entry.py
#  （接阶段一 5 自由度数字水池——此前的"est 状态回灌"式干跑没有动力学，
#    机器人原地不动也能"通过"，是假测试，已废弃）
# ============================================================
if __name__ == '__main__':
    import math as _m
    import time
    from fleet_digital_pool import FleetDigitalPool

    WPS = [[7, 7, 0.5], [14, 10, 0.8], [23, 10, 0.6], [32, 7, 0.5]]
    WIDTH, START = 14.0, (2.0, 7.0, 0.45, 0.0)

    print('=== 蛟人核心·阶段三：多机编队闭环自检（阶段一数字水池驱动） ===')
    print(f'航点 {len(WPS)} 个，河宽 {WIDTH} m，3 机三角编队')

    fleet = FleetEngine(WPS, n=3, formation='triangle', mode='leader-follower',
                        width=WIDTH, start=START)
    plant = FleetDigitalPool(3, length=38.0, width=WIDTH, depth=2.2,
                             current=(0.0, 0.05), gust_amp=0.012)
    plant.reset([(START[0] + o[0], START[1] + o[1], START[2] + o[2], START[3])
                 for o in fleet.form[0].offsets])
    fleet.start()

    dt = 1.0 / RATE_CTRL
    t_sim, max_t = 0.0, 150.0
    min_sep, rms_peak = float('inf'), 0.0
    t0 = time.time()
    while t_sim < max_t and fleet.mission.state != 'DONE':
        imu, dep, vo = plant.sensors()
        cmds = fleet.step(imu, dep, vo, [None] * 3, t_sim, dt)
        plant.step(cmds, t_sim, dt)
        s = plant.states
        for i in range(3):
            for j in range(i + 1, 3):
                min_sep = min(min_sep, _m.hypot(s[i][0] - s[j][0], s[i][1] - s[j][1]))

        # 演示事件流：队形切换 → 领航失效 → 恢复
        if 20.0 < t_sim < 20.0 + dt:
            fleet.switch_formation('line')
            print(f'  [{t_sim:6.1f}s] 队形切换 → line（一字横队）')
        if 40.0 < t_sim < 40.0 + dt:
            fleet.switch_formation('triangle')
            print(f'  [{t_sim:6.1f}s] 队形切换 → triangle（三角）')
        if 50.0 < t_sim < 50.0 + dt:
            fleet.drop_agent(0)
            print(f'  [{t_sim:6.1f}s] 领航者失效 → 无领航一致性接管')
        if 68.0 < t_sim < 68.0 + dt:
            fleet.restore_agent(0)
            fleet.switch_mode('leader-follower')
            print(f'  [{t_sim:6.1f}s] 领航者恢复 + 切回领航-跟随')

        t_sim += dt
        if int(t_sim * 10) % 50 == 0 and t_sim - round(t_sim, 1) < dt / 2:
            q = fleet.debug()
            rms_peak = max(rms_peak, q['formation']['rms'])
            print(f'  [{t_sim:6.1f}s] WP {q["mission"]["wp_i"] + 1}/{q["mission"]["n_wp"]} | '
                  f'RMS={q["formation"]["rms"]:.3f}m | mode={q["mode"]} | '
                  f'topo={q["topology"]["pattern"]}')

    elapsed = time.time() - t0
    q = fleet.debug()
    ok = fleet.mission.state == 'DONE' and min_sep > 0.5
    print(f'\n闭环自检{"通过 [OK]" if ok else "未通过 [FAIL]"}：仿真 {t_sim:.1f}s，'
          f'耗时 {elapsed:.1f}s (≈{t_sim / max(elapsed, 1e-9):.0f}x 实时)')
    print(f'RMS 峰值: {rms_peak:.3f} m ｜ 最小机间距: {min_sep:.3f} m ｜ '
          f'任务: {fleet.mission.state} {q["mission"]["wp_i"]}/{q["mission"]["n_wp"]}')
