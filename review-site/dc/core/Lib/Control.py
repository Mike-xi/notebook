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
"""
from .Params import *


class Controller:
    def __init__(self):
        self.reset()

    def reset(self):
        self.iz = 0.0
        self.th_ref = 0.0
        self.out = (0.0, 0.0, 0.0, 0.5)

    def tick(self, est, mission, dt):
        if mission.state == 'IDLE':
            self.out = (0.0, 0.0, 0.0, 0.5)
            return self.out
        if mission.state == 'DONE':
            self.out = (0.0, 0.0, 0.0, 0.15)   # 排水上浮待回收
            return self.out
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
        self.iz = clamp(self.iz + B_KI * ez * dt, -BAL_I_LIM, BAL_I_LIM)
        s_cmd = 0.5 + clamp(B_KP * ez + self.iz, -0.5, 0.5)
        base = mission.base * mission.slow
        self.out = (base + turn, base - turn, delta, s_cmd)
        return self.out
