# coding: utf-8
"""
StateEstimation —— 视惯压融合状态估计（阶段二成果的部署形态）
============================================================
输入三路带噪测量（全部来自传感器，不读真值）：
  imu   : {'yaw','pitch','q','r'}  弧度 / 弧度每秒（JY901）
  depth : {'depth'}                米（MS5837，深度计=尺度锚）
  vo    : {'x','y','vx','vy'} 或 None（单目视觉里程计定位输出，
          漂移已被深度计尺度锚约束为有界 —— 阶段二 ORB-SLAM3 实验结论）
融合策略：
  * 姿态/角速度：互补滤波（IMU 100Hz 为主）
  * 深度/垂速：深度计低通 + 差分低通
  * 水平位置：航位推算(VO 地速) + VO 定位修正（POS_CORR）
  * 地速：VO 速度低通（VEL_LP）
"""
from .Params import *


class StateEstimator:
    def __init__(self):
        self.reset(0.0, 0.0, 0.0, 0.0)

    def reset(self, x, y, z, psi):
        self.x, self.y, self.z = x, y, z
        self.psi, self.theta = psi, 0.0
        self.q = self.r = 0.0
        self.zdot = 0.0
        self.vx = self.vy = 0.0
        self._pz = z

    def update(self, imu, depth, vo, dt):
        if imu:
            self.psi += wrap(imu['yaw'] - self.psi) * min(1.0, ATT_LP * dt)
            self.theta += (imu['pitch'] - self.theta) * min(1.0, ATT_LP * dt)
            self.q, self.r = imu['q'], imu['r']
        if depth:
            self.z += (depth['depth'] - self.z) * min(1.0, Z_LP * dt)
            zd = (self.z - self._pz) / dt if dt > 0 else 0.0
            self._pz = self.z
            self.zdot += (zd - self.zdot) * min(1.0, ZDOT_LP * dt)
        # 航位推算 + VO 修正
        self.x += self.vx * dt
        self.y += self.vy * dt
        if vo:
            k = min(1.0, POS_CORR * dt)
            self.x += (vo['x'] - self.x) * k
            self.y += (vo['y'] - self.y) * k
            kv = min(1.0, VEL_LP * dt)
            self.vx += (vo['vx'] - self.vx) * kv
            self.vy += (vo['vy'] - self.vy) * kv

    def as_dict(self):
        return {'x': self.x, 'y': self.y, 'z': self.z,
                'psi': self.psi, 'theta': self.theta,
                'q': self.q, 'r': self.r, 'zdot': self.zdot,
                'vx': self.vx, 'vy': self.vy}
