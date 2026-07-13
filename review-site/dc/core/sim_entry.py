# coding: utf-8
"""
sim_entry —— 蛟人核心的仿真接线层（网页只负责仿真，算法全在本包）
=================================================================
同一份 Lib 算法两处可用：

① 引擎展示.html（综合场景）：JSON API
     engine_init(cfg_json)  配置航点/河道
     engine_start()         任务开始
     engine_step(inp_json)  每 10ms 喂传感器数据，返回执行器指令+决策调试量
   网页只做"水池物理 + 传感器仿真 + 三维渲染"，感知融合/跟踪/决策/控制
   全部发生在本包 —— 与装机运行的 JiaoRen.py 共用同一套 Lib 类库。

② 可视化.html（🐍载入蛟人核心）：经典约定
     NAME / reset(env) / update(state, env, dt) -> (nL, nR, delta, s_cmd)
   自动优先用注入的 read_imu()/read_depth() 虚拟传感器。

③ 桌面 Python 直接跑（jiaoren_sim 数字水池）也走同一 update() 签名。
"""
import json
import math

from Lib.Params import *
from Lib.StateEstimation import StateEstimator
from Lib.Vision import VisionTracker
from Lib.Guidance import Mission
from Lib.Control import Controller

NAME = "蛟人核心（阶段一二集成）"


class Engine:
    """感知-决策-控制 一体化引擎。控制 100Hz / 决策 20Hz / 视觉由输入节拍驱动。"""

    def __init__(self, waypoints, width=10.0, start=(0, 0, 0.4, 0), loop=False, et_lim=None):
        self.est = StateEstimator()
        self.vision = VisionTracker()
        self.mission = Mission(waypoints, width=width, start_z=start[2], loop=loop,
                               et_lim=et_lim if et_lim else min(ET_LIM, 0.32 * width))
        self.ctrl = Controller()
        self.start_pose = start
        self.reset()

    def reset(self):
        x, y, z, psi = self.start_pose
        self.est.reset(x, y, z, psi)
        self.vision.reset()
        self.mission.reset(x, y)
        self.ctrl.reset()
        self.t = 0.0
        self._next_dec = 0.0

    def start(self):
        self.mission.start(self.est)

    def step(self, imu, depth, vo, dets, t, dt):
        """一个控制拍：融合→(视觉)→(决策)→控制。dets=None 表示本拍无视觉帧。"""
        self.t = t
        self.est.update(imu, depth, vo, dt)
        if dets is not None:
            self.vision.tick(dets, self.est, t, 1.0 / RATE_VISION)
        if t >= self._next_dec:
            self.mission.tick(self.vision.confirmed(), self.est, 1.0 / RATE_DECIDE)
            self._next_dec = t + 1.0 / RATE_DECIDE
        return self.ctrl.tick(self.est, self.mission, dt)

    # ---- 供网页 HUD / 判定图形使用的完整决策快照 ----
    def debug(self):
        m, e = self.mission, self.est
        r3 = lambda v: round(v, 3)
        tracks = []
        for tr in self.vision.confirmed():
            tracks.append({'id': tr.id, 'x': r3(tr.x), 'y': r3(tr.y),
                           'vx': r3(tr.vx), 'vy': r3(tr.vy), 'type': tr.type,
                           'r': r3(tr.r), 'full': tr.full, 'side': tr.side,
                           'threat': tr.cpa is not None,
                           'cpa_d': r3(tr.cpa['d']) if tr.cpa else None,
                           'cpa_t': r3(tr.cpa['t']) if tr.cpa else None})
        return {
            'est': {'x': r3(e.x), 'y': r3(e.y), 'z': r3(e.z),
                    'psi': r3(e.psi), 'theta': r3(e.theta), 'zdot': r3(e.zdot),
                    'vx': r3(e.vx), 'vy': r3(e.vy)},
            'mission': {'state': m.state, 'wp_i': m.wp_i, 'n_wp': len(m.wps),
                        'psi_d': r3(m.psi_d), 'zref': r3(m.zref), 'base': r3(m.base),
                        'slow': r3(m.slow), 'avoid_mode': m.avoid_mode,
                        'avoid_count': m.avoid_count, 'e': r3(m.e), 'eT': r3(m.eT),
                        'lo': None if m.lo is None else r3(m.lo),
                        'hi': None if m.hi is None else r3(m.hi),
                        'leg_from': [r3(m.leg_from[0]), r3(m.leg_from[1])],
                        'threat_id': m.threat.id if m.threat else None,
                        'route_rev': m.route_rev},
            'ctrl': {'out': [r3(v) for v in self.ctrl.out], 'th_ref': r3(self.ctrl.th_ref)},
            'tracks': tracks,
        }

    def pop_events(self):
        return self.vision.pop_events() + self.mission.pop_events()


# =====================================================================
# ① 引擎展示.html 的 JSON API
# =====================================================================
_E = None


def engine_init(cfg_json):
    global _E
    cfg = json.loads(cfg_json)
    _E = Engine(cfg['waypoints'], width=cfg.get('width', 10.0),
                start=tuple(cfg.get('start', (0, 0, 0.4, 0))),
                loop=bool(cfg.get('loop', False)),
                et_lim=cfg.get('et_lim'))
    return NAME


def engine_start():
    _E.start()


def engine_reset():
    _E.reset()


def engine_step(inp_json):
    inp = json.loads(inp_json)
    cmd = _E.step(inp.get('imu'), inp.get('depth'), inp.get('vo'),
                  inp.get('dets'), inp['t'], inp['dt'])
    return json.dumps({'cmd': list(cmd), 'debug': _E.debug(),
                       'events': _E.pop_events()}, ensure_ascii=False)


# =====================================================================
# ② 可视化.html / jiaoren_sim 的经典 update() 约定
# =====================================================================
_VE = None            # 可视化模式下的 Engine
_V_started = False


class _HoldMission:
    """无航点场景的兜底：保持初始航向与深度（悬停演示）。"""
    def __init__(self, psi, z):
        self.state = 'TRANSIT'
        self.psi_d = psi
        self.zref = z
        self.base = 0.0
        self.slow = 1.0


_HOLD = None


def reset(env):
    global _VE, _V_started, _HOLD
    _VE = None
    _V_started = False
    _HOLD = None


def _mk_engine(state, env):
    wps = [list(w) for w in (env.get('waypoints') or [])]
    return Engine(wps, width=env.get('width', 10.0),
                  start=(state['x'], state['y'], state['z'], state['psi']),
                  loop=True)


def update(state, env, dt):
    """可视化.html 直载入口：优先用注入的虚拟传感器 read_imu/read_depth。"""
    global _VE, _V_started, _HOLD
    state = dict(state)
    env = dict(env) if not isinstance(env, dict) else env
    g = globals()

    # --- 组装传感器输入（无传感器注入时退化用状态量，便于纯Python水池联调） ---
    if 'read_imu' in g and g['read_imu'] is not None:
        raw = dict(g['read_imu'](env.get('idx', 0)))
        gyro = list(raw.get('gyro', (0, 0, 0)))
        imu = {'yaw': raw['yaw'] * D2R, 'pitch': raw['pitch'] * D2R,
               'q': gyro[1] * D2R, 'r': gyro[2] * D2R}
    else:
        imu = {'yaw': state['psi'], 'pitch': state['theta'],
               'q': state['q'], 'r': state['r']}
    if 'read_depth' in g and g['read_depth'] is not None:
        d = dict(g['read_depth'](env.get('idx', 0)))
        depth = {'depth': d['depth']}
    else:
        depth = {'depth': state['z']}
    # 可视化场景无 VO 仿真：定位直接取状态（说明：引擎展示.html 中
    # 该路输入换成"真值+有界漂移"的视惯压融合模拟，接口完全相同）
    cps, sps = math.cos(state['psi']), math.sin(state['psi'])
    cth = math.cos(state['theta'])
    vo = {'x': state['x'], 'y': state['y'],
          'vx': cps * cth * state['u'] - sps * state['v'],
          'vy': sps * cth * state['u'] + cps * state['v']}

    # --- 无航点场景：航向/深度保持 ---
    if not (env.get('waypoints') or []):
        if _HOLD is None:
            _HOLD = _HoldMission(state['psi'], max(0.3, state['z']))
        if _VE is None:
            _VE = Engine([], start=(state['x'], state['y'], state['z'], state['psi']))
        _VE.est.update(imu, depth, vo, dt)
        return _VE.ctrl.tick(_VE.est, _HOLD, dt)

    # --- 正常航点巡航 ---
    if _VE is None:
        _VE = _mk_engine(state, env)
    if not _V_started:
        _VE.start()
        _V_started = True
    cmd = _VE.step(imu, depth, vo, None, state['t'], dt)
    if 'report_xte' in g and g['report_xte'] is not None:
        g['report_xte'](_VE.mission.e)
    if 'set_wp' in g and g['set_wp'] is not None:
        g['set_wp'](_VE.mission.wp_i)
    return cmd
