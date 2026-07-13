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
  * 最近邻关联 + α-β 滤波（CV 匀速模型）
  * 静态类别（礁石/桥墩）用零速度先验 —— 分类器已给类别，
    对静止目标再估速度只会引入噪声、抖坏 CPA 判定
  * 出视场短时记忆：静态 20s / 动态 CV 外推 3s —— 防"转出视场
    →威胁消失→制导拉回→转回来再撞"
"""
import math
from .Params import *


class Track:
    __slots__ = ('id', 'x', 'y', 'vx', 'vy', 'hits', 'last_t', 'type',
                 'r', 'draft', 'full', 'announced', 'side', 'cpa', 'matched')

    def __init__(self, tid, x, y, d):
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

    def tick(self, dets, est, t, dt_v):
        """dets: 体轴系带噪检测列表; est: StateEstimator; dt_v: 视觉周期"""
        # 1) 体轴系 → 世界系（用估计位姿）
        world = []
        for d in dets:
            ang = est.psi + d['brg']
            world.append((est.x + d['rg'] * math.cos(ang),
                          est.y + d['rg'] * math.sin(ang), d))
        # 2) 最近邻关联 + α-β 滤波
        for tr in self.tracks:
            tr.matched = False
        for (wx, wy, d) in world:
            best, bd = None, VIS_GATE
            for tr in self.tracks:
                pdx = wx - (tr.x + tr.vx * dt_v)
                pdy = wy - (tr.y + tr.vy * dt_v)
                dist = math.hypot(pdx, pdy)
                if dist < bd and tr.type == d['type']:
                    bd, best = dist, tr
            if best is not None:
                if best.full:
                    best.x += VIS_A_STAT * (wx - best.x)
                    best.y += VIS_A_STAT * (wy - best.y)
                else:
                    pr_x = best.x + best.vx * dt_v
                    pr_y = best.y + best.vy * dt_v
                    best.x = pr_x + VIS_A_DYN * (wx - pr_x)
                    best.y = pr_y + VIS_A_DYN * (wy - pr_y)
                    best.vx += VIS_B_DYN * (wx - pr_x) / dt_v
                    best.vy += VIS_B_DYN * (wy - pr_y) / dt_v
                best.hits += 1
                best.last_t = t
                best.matched = True
                best.r = d['r']
            else:
                tr = Track(self._next_id, wx, wy, d)
                tr.last_t = t
                self._next_id += 1
                self.tracks.append(tr)
        # 3) 生命周期：未匹配的动态目标 CV 外推；超时删除
        for tr in self.tracks:
            if not tr.matched and not tr.full:
                tr.x += tr.vx * dt_v
                tr.y += tr.vy * dt_v
        self.tracks = [tr for tr in self.tracks
                       if t - tr.last_t < (VIS_MEM_STATIC if tr.full else VIS_MEM_DYN)]
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
