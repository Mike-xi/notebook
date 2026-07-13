# coding: utf-8
"""
StateEstimation —— 视惯压融合状态估计（阶段二成果的部署形态）
============================================================
输入三路带噪测量（全部来自传感器，不读真值）：
  imu   : {'yaw','pitch','q','r'}  弧度 / 弧度每秒（JY901）
  depth : {'depth'}                米（MS5837，深度计=尺度锚）
  vo    : {'x','y','vx','vy'} 或 None（单目视觉里程计 / 阶段五岸基外定位，
          漂移已被深度计尺度锚约束为有界 —— 阶段二 ORB-SLAM3 实验结论）

阶段五 O2 硬件化（2026-07-10，对标 ArduPilot EKF3 的"门控/健康度/降级"
思想，不移植其架构）：
  * 姿态改为陀螺积分主导 + 融合航向慢修正（YAW_CORR，τ≈2s）——
    JY901 磁力计离推进电机很近，电机磁干扰只会以慢速率渗入而非直接打歪；
  * 全部测量通道加新息门限（YAW_GATE/Z_GATE/POS_GATE）：单发坏测量被
    拒绝；连续超门 *_BAD_N 个样本判定"估计器错了"→ 认输重置到测量；
  * VO/外定位断流 VO_TIMEOUT 后降级为模型辅助航位推算（推力占比→
    稳态航速映射 u_model + 航向合成地速），不再冻结旧速度。
"""
import math

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
        self._yaw_bad = 0
        self._th_bad = 0
        self._z_bad = 0
        self._pos_bad = 0
        self._vo_age = 1e9     # 距上次 VO/外定位 [s]（初始视为断流）

    def update(self, imu, depth, vo, dt, u_cmd=None):
        """u_cmd：当前推力占比（(nL+nR)/2），供断流降级推算；None=不启用。"""
        if imu:
            self.q, self.r = imu['q'], imu['r']
            # 陀螺积分主导
            self.psi = wrap(self.psi + self.r * dt)
            self.theta += self.q * dt
            # 融合航向/俯仰慢修正（带新息门限 + 持续超门重置）
            inn = wrap(imu['yaw'] - self.psi)
            if abs(inn) <= YAW_GATE:
                self.psi = wrap(self.psi + inn * min(1.0, YAW_CORR * dt))
                self._yaw_bad = 0
            else:
                self._yaw_bad += 1
                if self._yaw_bad >= YAW_BAD_N:
                    self.psi, self._yaw_bad = imu['yaw'], 0
            inn = imu['pitch'] - self.theta
            if abs(inn) <= YAW_GATE:
                self.theta += inn * min(1.0, YAW_CORR * dt)
                self._th_bad = 0
            else:
                self._th_bad += 1
                if self._th_bad >= YAW_BAD_N:
                    self.theta, self._th_bad = imu['pitch'], 0
        if depth:
            inn = depth['depth'] - self.z
            if abs(inn) <= Z_GATE:                 # 压力尖峰拒绝
                self.z += inn * min(1.0, Z_LP * dt)
                self._z_bad = 0
            else:
                self._z_bad += 1
                if self._z_bad >= Z_BAD_N:
                    self.z, self._z_bad = depth['depth'], 0
            zd = (self.z - self._pz) / dt if dt > 0 else 0.0
            self._pz = self.z
            self.zdot += (zd - self.zdot) * min(1.0, ZDOT_LP * dt)
        # 航位推算 + VO/外定位修正
        self._vo_age += dt
        self.x += self.vx * dt
        self.y += self.vy * dt
        if vo:
            dx, dy = vo['x'] - self.x, vo['y'] - self.y
            if dx * dx + dy * dy <= POS_GATE * POS_GATE:
                k = min(1.0, POS_CORR * dt)
                self.x += dx * k
                self.y += dy * k
                self._pos_bad = 0
            else:
                self._pos_bad += 1
                if self._pos_bad >= POS_BAD_N:
                    self.x, self.y, self._pos_bad = vo['x'], vo['y'], 0
            kv = min(1.0, VEL_LP * dt)
            self.vx += (vo['vx'] - self.vx) * kv
            self.vy += (vo['vy'] - self.vy) * kv
            self._vo_age = 0.0
        elif u_cmd is not None and self._vo_age > VO_TIMEOUT:
            # 断流降级：模型航速 + 当前航向 合成地速（缓混，不硬切）
            u = u_model(u_cmd)
            k = min(1.0, VEL_LP * dt)
            self.vx += (u * math.cos(self.psi) - self.vx) * k
            self.vy += (u * math.sin(self.psi) - self.vy) * k

    def as_dict(self):
        return {'x': self.x, 'y': self.y, 'z': self.z,
                'psi': self.psi, 'theta': self.theta,
                'q': self.q, 'r': self.r, 'zdot': self.zdot,
                'vx': self.vx, 'vy': self.vy}
