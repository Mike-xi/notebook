# coding: utf-8
"""
swarm_entry —— 阶段三多机编队仿真接线层（网页只做水池仿真+渲染）
=================================================================
沿用阶段一二 sim_entry 的组织：网页造"带噪测量"，感知/决策/控制全在本包。

    每机：StateEstimation（视惯压融合，阶段二）+ Control（M1 双闭环+浮潜协同，阶段一）
    编队：Formation（图论一致性分布式协同，阶段三）——
          输出各机 (ψd, zref, base) 正好喂给各机 Controller，零改动级联。
    参考：编队虚拟质心走 LOS 矩形巡逻航线（含变深）——
          同时满足阶段三第 1 项"单机 LOS 含变深巡逻"（质心即等效单机航路）。

JSON API（供 编队演示.html）：
    swarm_init(cfg)   配置机数/模式/队形/巡逻矩形
    swarm_start()
    swarm_step(inp)   每 10ms 喂各机传感器，返回各机执行器指令 + 编队诊断
    swarm_set(cmd)    运行时操控：切队形/切拓扑/失效/恢复/切模式（体现鲁棒性）
"""
import json
import math

from Lib.Params import *
from Lib.StateEstimation import StateEstimator
from Lib.Control import Controller
from Lib.Formation import Formation, rot2

NAME = "蛟人编队核心（阶段三·图论一致性）"


class _Ref:
    """轻量对象，把 dict 估计包装成有 .x/.y/... 属性（Formation 只读这些）。"""
    __slots__ = ('x', 'y', 'z', 'vx', 'vy', 'psi')

    def __init__(self, e):
        self.x, self.y, self.z = e.x, e.y, e.z
        self.vx, self.vy = e.vx, e.vy
        self.psi = e.psi


class LOSGuide:
    """编队虚拟质心的 LOS 矩形巡逻制导（含变深）。
    生成参考 {x,y,z,vx,vy}，横向跟踪用与阶段一同构的 LOS 前视法。
    验收对标：恒定流+扰动下横偏 < 0.5 艇长(0.275m)。"""

    def __init__(self, waypoints, u_des=0.30, loop=True):
        self.wps = [list(w) for w in waypoints]
        self.u_des = u_des
        self.loop = loop
        self.reset(waypoints[0][0], waypoints[0][1])

    def reset(self, x0, y0):
        self.x, self.y = x0, y0
        self.z = self.wps[0][2]
        self.vx = self.vy = 0.0
        self.wp_i = 0
        self.leg_from = [x0, y0]
        self.e_int = 0.0
        self.laps = 0
        self.e = 0.0
        self._e_sum = 0.0
        self._e_n = 0
        self.done = False
        self.events = []

    def pop_events(self):
        ev, self.events = self.events, []
        return ev

    def tick(self, dt, fleet_c=None):
        """推进虚拟质心：LOS 求期望航向 → 以 u_des 前进 → 更新参考位姿。
        fleet_c=(cx,cy)：实际活跃机质心。给定时启用"牵引缰绳(leash)"——
        参考领先实际编队越多、前进越慢，避免欠驱动艇转弯超调后被参考甩开
        (标准 virtual-leader path-following 做法：把参考栓在编队前方一个艇距内)。"""
        if self.done:
            self.vx = self.vy = 0.0
            return self.ref()
        wp = self.wps[self.wp_i]
        if math.hypot(wp[0] - self.x, wp[1] - self.y) < WP_R * 1.4:
            mean_e = self._e_sum / self._e_n if self._e_n else 0.0
            self.events.append('📍 编队质心抵达航点 <b>%d/%d</b>（LOS 横偏均值 %.3f m）'
                               % (self.wp_i + 1, len(self.wps), mean_e))
            self.leg_from = [wp[0], wp[1]]
            self.wp_i += 1
            self.e_int = 0.0
            if self.wp_i >= len(self.wps):
                if self.loop:
                    self.wp_i = 0
                    self.laps += 1
                    self.events.append('🔁 巡逻一圈完成，继续（第 %d 圈）' % (self.laps + 1))
                else:
                    self.done = True
                    self.events.append('✅ 矩形巡逻航线完成')
                    return self.ref()
        wpn = self.wps[self.wp_i]
        dx = wpn[0] - self.leg_from[0]
        dy = wpn[1] - self.leg_from[1]
        path_ang = math.atan2(dy, dx)
        lp = math.hypot(dx, dy) or 1e-6
        ex = self.x - self.leg_from[0]
        ey = self.y - self.leg_from[1]
        e = (ey * dx - ex * dy) / lp          # 横向跟踪误差
        self.e = e
        self._e_sum += abs(e)
        self._e_n += 1
        # ILOS 积分视线（与阶段一 Guidance 同式）
        denom = LOOKAHEAD ** 2 + (e + KAPPA * self.e_int) ** 2
        self.e_int = clamp(self.e_int + INT_GAIN * (LOOKAHEAD * e / denom) * dt, -INT_LIM, INT_LIM)
        psi_d = path_ang + math.atan2(-(e + KAPPA * self.e_int), LOOKAHEAD)
        spd = self.u_des
        # 转弯减速：临近本段终点航点时线性收速到 CORNER_V_MIN·u_des，
        #   让欠驱动艇(~20°/s 转艏率)在参考的陪伴下转过 90° 弯，而非带惯性冲过角点撞壁。
        d_to_wp = math.hypot(wpn[0] - self.x, wpn[1] - self.y)
        if d_to_wp < CORNER_SLOW_D:
            spd *= CORNER_V_MIN + (1.0 - CORNER_V_MIN) * (d_to_wp / CORNER_SLOW_D)
        # 牵引缰绳：按"参考领先实际编队质心的纵向距离"给前进速度再打折。
        #   lead = 参考相对编队质心在期望航向上的投影；lead 越大 → 参考跑太前 → 减速等编队。
        #   sat 在 (0,1]：lead<=SLACK 满速；lead>=MAX 停步等待。杜绝参考甩开编队。
        if fleet_c is not None:
            lead = (self.x - fleet_c[0]) * math.cos(psi_d) + (self.y - fleet_c[1]) * math.sin(psi_d)
            spd *= clamp(1.0 - (lead - LEASH_SLACK) / (LEASH_MAX - LEASH_SLACK), 0.0, 1.0)
        self.vx = spd * math.cos(psi_d)
        self.vy = spd * math.sin(psi_d)
        self.x += self.vx * dt
        self.y += self.vy * dt
        self.z += clamp(wpn[2] - self.z, -0.4 * dt, 0.4 * dt)
        return self.ref()

    def ref(self):
        return {'x': self.x, 'y': self.y, 'z': self.z, 'vx': self.vx, 'vy': self.vy}


class SwarmEngine:
    """N 机编队一体化引擎：各机融合估计 → 图论一致性编队 → 各机运动控制。"""

    def __init__(self, n=3, mode='leaderless', shape='三角',
                 waypoints=None, width=10.0, starts=None, u_des=0.30, loop=True):
        self.n = n
        self.width = width
        self.ests = [StateEstimator() for _ in range(n)]
        self.ctrls = [Controller() for _ in range(n)]
        self.form = Formation(n=n, mode=mode, shape=shape)
        self.guide = LOSGuide(waypoints, u_des=u_des, loop=loop)
        self.starts = starts or [(0, i * 1.5, 0.4, 0) for i in range(n)]
        self._next_dec = 0.0
        self.t = 0.0
        self.reset()

    def reset(self):
        for i in range(self.n):
            x, y, z, psi = self.starts[i]
            self.ests[i].reset(x, y, z, psi)
            self.ctrls[i].reset()
        self.guide.reset(self.starts[0][0], self.starts[0][1])
        # 参考质心初值设在各机质心，避免启动冲刺
        cx = sum(s[0] for s in self.starts) / self.n
        cy = sum(s[1] for s in self.starts) / self.n
        self.guide.x, self.guide.y = cx, cy
        self.form.reset(self.ests)
        self.t = 0.0
        self._next_dec = 0.0
        self.started = False

    def start(self):
        self.started = True

    class _Mission:
        """把编队层的 (psi_d, zref, base) 包装成 Controller 认的 mission 接口。"""
        __slots__ = ('state', 'psi_d', 'zref', 'base', 'slow')

        def __init__(self, psi_d, zref, base):
            self.state = 'TRANSIT'
            self.psi_d = psi_d
            self.zref = zref
            self.base = base
            self.slow = 1.0

    def step(self, imus, depths, vos, t, dt):
        """一个控制拍：各机融合 → (决策拍)编队一致性 → 各机控制。"""
        self.t = t
        for i in range(self.n):
            if not self.form.alive[i]:
                continue
            self.ests[i].update(imus[i], depths[i], vos[i], dt)
        # 决策拍：推进参考质心 + 跑一次图论一致性编队
        if self.started and t >= self._next_dec:
            # 实际活跃机质心（喂给 leash：参考不甩开欠驱动编队）
            act = [i for i in range(self.n) if self.form.alive[i]]
            if act:
                fc = (sum(self.ests[i].x for i in act) / len(act),
                      sum(self.ests[i].y for i in act) / len(act))
            else:
                fc = None
            ref = self.guide.tick(1.0 / RATE_DECIDE, fleet_c=fc)
            self.form.tick(self.ests, ref, 1.0 / RATE_DECIDE)
            self._next_dec = t + 1.0 / RATE_DECIDE
        # 各机控制（失效机停车）
        cmds = []
        for i in range(self.n):
            if not self.form.alive[i]:
                cmds.append((0.0, 0.0, 0.0, 0.5))
                continue
            m = self._Mission(self.form.psi_d[i], self.form.zref[i], self.form.base[i])
            cmds.append(self.ctrls[i].tick(self.ests[i], m, dt))
        return cmds

    # ---- 运行时操控（鲁棒性演示） ----
    def set_shape(self, shape):
        self.form.set_shape(shape, morph=True)
        self.form.events.append('🔷 队形变换 → <b>%s</b>（%.1fs 平滑过渡）' % (shape, FORM_MORPH_T))

    def set_mode(self, mode):
        self.form.mode = mode
        self.form.events.append('🔁 协同结构切换 → <b>%s</b>'
                                % ('领航-跟随' if mode == 'leader' else '无领航一致性'))

    def set_topology(self, kind):
        if kind == 'ring':
            self.form.ring_topology()
            self.form.events.append('🕸 通信拓扑 → <b>全连通环</b>')
        elif kind == 'line':
            self.form.line_topology()
            self.form.events.append('🕸 通信拓扑 → <b>链式 0-1-2</b>（断一条弦，测残余连通保持）')

    def set_consensus(self, on):
        self.form.use_consensus = bool(on)
        self.form.events.append('🧠 协同算法 → <b>%s</b>'
                                % ('图论一致性（本课题）' if on else '无协同基线（对照）'))

    def fail(self, i):
        self.form.fail(i)

    def revive(self, i):
        self.form.revive(i)

    def debug(self):
        r3 = lambda v: round(v, 3)
        agents = []
        for i in range(self.n):
            e = self.ests[i]
            agents.append({
                'id': i, 'alive': self.form.alive[i],
                'x': r3(e.x), 'y': r3(e.y), 'z': r3(e.z),
                'psi': r3(e.psi), 'theta': r3(e.theta),
                'vx': r3(e.vx), 'vy': r3(e.vy),
                'psi_d': r3(self.form.psi_d[i]), 'zref': r3(self.form.zref[i]),
                'base': r3(self.form.base[i]),
                'xi': [r3(self.form.xi[i][0]), r3(self.form.xi[i][1])],
                'cmd': [r3(v) for v in self.ctrls[i].out],
            })
        # 邻接矩阵（活跃机之间的有效边，网页画通信链路）
        edges = []
        for i in range(self.n):
            for j in range(i + 1, self.n):
                if self.form.A[i][j] > 0:
                    edges.append([i, j, bool(self.form.alive[i] and self.form.alive[j])])
        return {
            'agents': agents,
            'ref': {k: r3(v) for k, v in self.guide.ref().items()},
            'form': {
                'mode': self.form.mode, 'shape': self.form.shape,
                'consensus': self.form.use_consensus,
                'psi_f': r3(self.form.psi_f),
                'form_err': r3(self.form.formation_error(self.ests)),
                'cons_err': r3(self.form.consensus_error()),
                'connected': self.form.is_connected(),
                'morphing': self.form.morph_t > 0.0,
                'n_alive': sum(self.form.alive),
                'los_e': r3(self.guide.e), 'wp_i': self.guide.wp_i,
                'n_wp': len(self.guide.wps), 'laps': self.guide.laps,
            },
            'edges': edges,
        }

    def pop_events(self):
        return self.guide.pop_events() + self.form.pop_events()


# =====================================================================
# JSON API
# =====================================================================
_S = None


def swarm_init(cfg_json):
    global _S
    cfg = json.loads(cfg_json)
    _S = SwarmEngine(
        n=cfg.get('n', 3), mode=cfg.get('mode', 'leaderless'),
        shape=cfg.get('shape', '三角'),
        waypoints=cfg['waypoints'], width=cfg.get('width', 10.0),
        starts=[tuple(s) for s in cfg['starts']] if cfg.get('starts') else None,
        u_des=cfg.get('u_des', 0.30), loop=cfg.get('loop', True))
    return NAME


def swarm_start():
    _S.start()


def swarm_reset():
    _S.reset()


def swarm_step(inp_json):
    inp = json.loads(inp_json)
    cmds = _S.step(inp['imu'], inp['depth'], inp['vo'], inp['t'], inp['dt'])
    return json.dumps({'cmds': [list(c) for c in cmds], 'debug': _S.debug(),
                       'events': _S.pop_events()}, ensure_ascii=False)


def swarm_set(cmd_json):
    cmd = json.loads(cmd_json)
    op = cmd.get('op')
    if op == 'shape':
        _S.set_shape(cmd['value'])
    elif op == 'mode':
        _S.set_mode(cmd['value'])
    elif op == 'topology':
        _S.set_topology(cmd['value'])
    elif op == 'consensus':
        _S.set_consensus(cmd['value'])
    elif op == 'fail':
        _S.fail(int(cmd['value']))
    elif op == 'revive':
        _S.revive(int(cmd['value']))
    return json.dumps({'ok': True, 'events': _S.pop_events()}, ensure_ascii=False)
