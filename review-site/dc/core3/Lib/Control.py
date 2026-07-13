# coding: utf-8
"""
Control —— 运动控制层：M1 双闭环 + 浮潜协同变深（阶段一成果）
=============================================================
  * 航向环：P 吃误差 + D 用 -r 阻尼（M1 整定 kp=3.0 kd=1.5，
    超调 4.7%、调节 3.6s），输出差速指令；
  * 变深＝浮潜协同：尾舵"深度→俯仰→舵角"级联管瞬态（外环带 ż 阻尼，
    治三阶非最小相位极限环），压载慢 PI 管稳态配平 —— 频带分离，
    比仅压载快 29%，停车悬停仍有效；
  * 只用估计值，不用真值。输出 (nL, nR, delta, s_cmd)：
    左右桨 [-1,1]、尾舵 [rad]、压载注水指令 [0,1]。

阶段五 O3 工程保护（2026-07-10）—— 仅实物启用 Controller(protect=True)：
  * 舵/压载指令速率限幅（RUD_RATE/BAL_RATE）——护舵机、防针筒来回抽，
    并平滑模式/航点切换的指令阶跃（bumpless transfer）；
  * 压载积分死区 DEAD_Z + 条件积分抗饱和（顶满同向停积）。
  ⚠ 仿真/演示页默认 protect=False，输出与阶段一原版逐拍完全一致。
    A/B 教训（2026-07-10 探针）：抗饱和会改变长变深段的压载积分行为→
    深度轨迹→滑翔地速相位，引擎场景中 4 号大鱼处即翻成碰撞——该处本为
    边缘工况（全原版今日 minClear 也仅 0.21m），场景余量问题另行排查，
    在此之前保护逻辑不进演示链路。
"""
from .Params import *


class Controller:
    def __init__(self, protect=False):
        self.protect = protect     # True=实物（JiaoRen.py）；False=仿真原版行为
        self.reset()

    def reset(self):
        self.iz = 0.0
        self.th_ref = 0.0
        self.out = (0.0, 0.0, 0.0, 0.5)
        self._delta = 0.0          # 上一拍实际下发舵角（速率限幅状态）
        self._s = 0.5              # 上一拍实际下发压载指令

    @staticmethod
    def _slew(target, prev, rate, dt):
        step = rate * dt
        return clamp(target, prev - step, prev + step)

    def _hold(self, s_target, dt):
        """停车姿态。实物：推力立即归零，舵/压载按速率回位；仿真：原版直跳。"""
        if self.protect:
            self._delta = self._slew(0.0, self._delta, RUD_RATE, dt)
            self._s = self._slew(s_target, self._s, BAL_RATE, dt)
        else:
            self._delta, self._s = 0.0, s_target
        self.out = (0.0, 0.0, self._delta, self._s)
        return self.out

    def tick(self, est, mission, dt):
        if mission.state == 'IDLE':
            return self._hold(0.5, dt)
        if mission.state == 'DONE':
            return self._hold(0.15, dt)   # 排水上浮待回收
        # 航向环（M1）
        turn = clamp(H_KP * wrap(mission.psi_d - est.psi) - H_KD * est.r,
                     -TURN_LIM, TURN_LIM)
        # 变深：尾舵级联（瞬态）+ 压载慢 PI（稳态），频带分离
        th_ref = clamp(K_Z * (est.z - mission.zref) + K_ZD * est.zdot,
                       -TH_LIM, TH_LIM)
        self.th_ref = th_ref
        delta = clamp(K_TH * (th_ref - est.theta) - K_Q * est.q,
                      -RUD_LIM, RUD_LIM)
        ez = mission.zref - est.z
        if self.protect:
            # 死区外才积分；输出顶满且误差同向时停积（条件抗饱和）
            ez_i = ez if abs(ez) > DEAD_Z else 0.0
            pi_raw = B_KP * ez + self.iz
            pushing_sat = (pi_raw >= 0.5 and ez_i > 0) or (pi_raw <= -0.5 and ez_i < 0)
            if not pushing_sat:
                self.iz = clamp(self.iz + B_KI * ez_i * dt, -BAL_I_LIM, BAL_I_LIM)
        else:
            self.iz = clamp(self.iz + B_KI * ez * dt, -BAL_I_LIM, BAL_I_LIM)
        s_cmd = 0.5 + clamp(B_KP * ez + self.iz, -0.5, 0.5)
        if self.protect:
            delta = self._delta = self._slew(delta, self._delta, RUD_RATE, dt)
            s_cmd = self._s = self._slew(s_cmd, self._s, BAL_RATE, dt)
        else:
            self._delta, self._s = delta, s_cmd
        base = mission.base * mission.slow
        self.out = (base + turn, base - turn, delta, s_cmd)
        return self.out
