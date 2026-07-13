# coding: utf-8
"""
Vision —— 视觉目标跟踪与局部障碍地图（感知层后端）
==================================================
输入：目标检测前端的输出（实物 = OpenCV/检测模型处理相机帧；
     仿真 = 网页按同格式生成的带噪检测），本体系测量：
  dets: [{'rg':距离m, 'brg':方位rad(体轴系), 'type':类别,
          'r':半径m, 'draft':吃水m, 'full':是否全水深}, ...]
处理：
  * 用自身估计位姿把检测换算到世界系（引擎一致地生活在估计坐标系里）
  * 全局贪心一对一关联（O6，SORT 轻量子集）：候选按距离排序、
    每条检测/每条轨迹一帧至多配一次 —— 多目标同类近距时，逐检测
    独立找最近邻会让两条检测重复更新同一轨迹，速度被打坏
  * α-β 滤波（CV 匀速模型），速度限幅 VIS_VMAX（关联错一拍不至于
    把 CPA/前馈炸飞）
  * 断链重捕：动态目标机动（受惊窜逃）超出关联门时，优先用放宽门
    重捕失配轨迹，而不是另起新 ID —— 否则旧轨迹带着过期速度当
    3s 幽灵、新轨迹速度为零，走廊约束两头都错（探针实测擦碰主因）
  * streak = 连续命中帧数（成熟度）：制导层据此决定是否信任速度
    前馈、以及给不成熟轨迹加保守膨胀（O9-lite）
  * 静态类别（礁石/桥墩）用零速度先验 —— 分类器已给类别，
    对静止目标再估速度只会引入噪声、抖坏 CPA 判定
  * 出视场短时记忆：静态 20s / 动态 CV 外推 3s —— 防"转出视场
    →威胁消失→制导拉回→转回来再撞"
"""
import math
from .Params import *


class Track:
    __slots__ = ('id', 'x', 'y', 'vx', 'vy', 'hits', 'last_t', 'type',
                 'r', 'draft', 'full', 'static', 'announced', 'side', 'cpa',
                 'matched', 'miss', 'streak')

    def __init__(self, tid, x, y, d):
        self.miss = 0
        self.streak = 1
        self.static = d['type'] in VIS_STATIC   # 静态类别（full≠static：大鱼全水深但会动）
        self.id = tid
        self.x, self.y = x, y
        self.vx = self.vy = 0.0
        self.hits = 1
        self.last_t = 0.0
        self.type = d['type']
        self.r = d['r']
        self.draft = d.get('draft', 0.0)
        self.full = bool(d.get('full'))
        self.announced = False
        self.side = 0        # 规避让开侧锁定（由制导层写入）
        self.cpa = None      # 当前会遇解算（由制导层写入）
        self.matched = False


class VisionTracker:
    def __init__(self):
        self.reset()

    def reset(self):
        self.tracks = []
        self._next_id = 1
        self.events = []

    def _update(self, tr, w, t, dt_v):
        """常规量测更新：α-β（动态）/位置平滑（静态）+ 速度限幅 + 成熟度"""
        wx, wy, d = w
        if tr.static:
            tr.x += VIS_A_STAT * (wx - tr.x)
            tr.y += VIS_A_STAT * (wy - tr.y)
        else:
            pr_x = tr.x + tr.vx * dt_v
            pr_y = tr.y + tr.vy * dt_v
            tr.x = pr_x + VIS_A_DYN * (wx - pr_x)
            tr.y = pr_y + VIS_A_DYN * (wy - pr_y)
            tr.vx += VIS_B_DYN * (wx - pr_x) / dt_v
            tr.vy += VIS_B_DYN * (wy - pr_y) / dt_v
            v = math.hypot(tr.vx, tr.vy)
            if v > VIS_VMAX:                 # 关联错一拍也别把 CPA/前馈炸飞
                tr.vx *= VIS_VMAX / v
                tr.vy *= VIS_VMAX / v
        tr.hits += 1
        tr.streak += 1
        tr.last_t = t
        tr.matched = True
        tr.miss = 0
        tr.r = d['r']

    def tick(self, dets, est, t, dt_v):
        """dets: 体轴系带噪检测列表; est: StateEstimator; dt_v: 视觉周期"""
        # 1) 体轴系 → 世界系（用估计位姿）
        world = []
        for d in dets:
            ang = est.psi + d['brg']
            world.append((est.x + d['rg'] * math.cos(ang),
                          est.y + d['rg'] * math.sin(ang), d))
        # 2) 全局贪心一对一关联 + α-β 滤波（O6）
        for tr in self.tracks:
            tr.matched = False
        cands = []                       # (预测距离, 检测序号, 轨迹)
        for k, (wx, wy, d) in enumerate(world):
            for tr in self.tracks:
                if tr.type != d['type']:
                    continue
                pdx = wx - (tr.x + tr.vx * dt_v)
                pdy = wy - (tr.y + tr.vy * dt_v)
                dist = math.hypot(pdx, pdy)
                if dist < VIS_GATE:
                    cands.append((dist, k, tr))
        cands.sort(key=lambda c: c[0])
        det_used = set()
        for dist, k, tr in cands:
            if tr.matched or k in det_used:
                continue
            self._update(tr, world[k], t, dt_v)
            det_used.add(k)
        # 2b) 断链重捕：剩余检测先尝试用放宽门（随失联时间增长）认领
        #     失配的同类动态轨迹——机动超门时接续旧 ID，不造"幽灵+双胞胎"
        for k, (wx, wy, d) in enumerate(world):
            if k in det_used:
                continue
            best, bd = None, None
            for tr in self.tracks:
                if tr.matched or tr.static or tr.type != d['type']:
                    continue
                gate2 = VIS_GATE + VIS_REACQ_K * max(0.0, t - tr.last_t)
                dist = math.hypot(wx - tr.x, wy - tr.y)
                if dist < gate2 and (bd is None or dist < bd):
                    bd, best = dist, tr
            if best is not None:
                # 位置直接吸附到检测；速度减半保留（方向大体可信、模长存疑）
                best.x, best.y = wx, wy
                best.vx *= 0.5
                best.vy *= 0.5
                best.streak = 1          # 重捕后按不成熟轨迹对待（制导层膨胀）
                best.hits += 1
                best.last_t = t
                best.matched = True
                best.miss = 0
                best.r = d['r']
            else:
                tr = Track(self._next_id, wx, wy, d)
                tr.last_t = t
                self._next_id += 1
                self.tracks.append(tr)
        # 3) 生命周期：未匹配的动态目标 CV 外推；超时删除。
        #    matched 轨迹推进 streak；失配清零（成熟度供制导层用）
        #    负证据：静态轨迹的位置明明在视场量程内、这一帧却没有任何检测
        #    与之关联 → 目标已被移走（如障碍被拖拽/漂走），连续 VIS_MISS_N
        #    帧即删——否则"短时记忆"会留下幽灵障碍，决策层被假约束缠住
        for tr in self.tracks:
            if tr.matched:
                continue
            tr.streak = 0
            if not tr.static:
                tr.x += tr.vx * dt_v
                tr.y += tr.vy * dt_v
            else:
                dxo, dyo = tr.x - est.x, tr.y - est.y
                rg = math.hypot(dxo, dyo)
                brg = abs(wrap(math.atan2(dyo, dxo) - est.psi))
                if 0.5 < rg < CAM_RANGE * 0.9 and brg < CAM_FOV * 0.9:
                    tr.miss += 1
        self.tracks = [tr for tr in self.tracks
                       if tr.miss < VIS_MISS_N
                       and t - tr.last_t < (VIS_MEM_STATIC if tr.static else VIS_MEM_DYN)]
        # 4) 新目标播报
        for tr in self.tracks:
            if tr.hits >= VIS_CONFIRM and not tr.announced:
                tr.announced = True
                rg = math.hypot(tr.x - est.x, tr.y - est.y)
                self.events.append('👁 视觉识别新目标 <b>#%d</b> %s，距 %.1f m'
                                   % (tr.id, OB_NAME.get(tr.type, tr.type), rg))

    def confirmed(self):
        return [tr for tr in self.tracks if tr.hits >= VIS_CONFIRM]

    def pop_events(self):
        ev, self.events = self.events, []
        return ev
