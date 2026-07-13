# coding: utf-8
"""
Sensors —— 实物传感器驱动封装（树莓派 Zero 2W）
================================================
统一输出与仿真接口完全一致的字典（弧度制/米制），算法层无感切换：
  imu()    -> {'yaw','pitch','q','r','t'}          （JY901，I2C 0x50）
  depth()  -> {'depth','t'}                        （MS5837 压力计）
  camera() -> 最新一帧灰度 ndarray 或 None          （艏部 1080P 单目）

寄存器解码沿用 学森挑战营代码\\GetIMU2_2.py / JY901I2C 系列的公式；
MS5837 直接用 JR_Beta\\lib\\ms5837 驱动。无硬件环境下自动降级为
None（JiaoRen.py 据此进入干跑模式）。
"""
import time
import math

D2R = math.pi / 180.0

try:
    import smbus
    _BUS = smbus.SMBus(1)
except Exception:
    _BUS = None

try:
    import ms5837 as _ms5837_mod
except Exception:
    _ms5837_mod = None

IMU_ADDR = 0x50


def _word(lo, hi, scale, span):
    v = ((hi << 8) | lo) / 32768.0 * scale
    return v - 2 * scale if v >= span else v


class IMU_JY901:
    """JY901 姿态传感器（I2C）。读欧拉角 + 角速度，输出弧度制。"""
    def available(self):
        return _BUS is not None

    def read(self):
        if _BUS is None:
            return None
        try:
            ang = _BUS.read_i2c_block_data(IMU_ADDR, 0x3d, 6)   # roll pitch yaw
            gyr = _BUS.read_i2c_block_data(IMU_ADDR, 0x37, 6)   # wx wy wz
            pitch = _word(ang[2], ang[3], 180.0, 180.0) * D2R
            yaw = _word(ang[4], ang[5], 180.0, 180.0) * D2R
            wy = _word(gyr[2], gyr[3], 2000.0, 2000.0) * D2R
            wz = _word(gyr[4], gyr[5], 2000.0, 2000.0) * D2R
            return {'yaw': yaw, 'pitch': pitch, 'q': wy, 'r': wz, 't': time.time()}
        except Exception:
            return None


class DepthMS5837:
    """MS5837 压力/深度计（淡水密度）。"""
    def __init__(self):
        self._dev = None
        if _ms5837_mod is not None:
            try:
                self._dev = _ms5837_mod.MS5837_30BA()
                self._dev.init()
                self._dev.setFluidDensity(_ms5837_mod.DENSITY_FRESHWATER)
            except Exception:
                self._dev = None

    def available(self):
        return self._dev is not None

    def read(self):
        if self._dev is None:
            return None
        try:
            if not self._dev.read():
                return None
            return {'depth': self._dev.depth(), 't': time.time()}
        except Exception:
            return None


class MonoCamera:
    """艏部单目相机（picamera2 优先，退回 OpenCV VideoCapture）。"""
    def __init__(self, size=(640, 480)):
        self._picam = None
        self._cv = None
        try:
            from picamera2 import Picamera2
            self._picam = Picamera2()
            self._picam.configure(self._picam.create_video_configuration(
                main={'size': size, 'format': 'RGB888'}))
            self._picam.start()
        except Exception:
            try:
                import cv2
                cap = cv2.VideoCapture(0)
                if cap.isOpened():
                    self._cv = cap
            except Exception:
                pass

    def available(self):
        return self._picam is not None or self._cv is not None

    def read(self):
        try:
            if self._picam is not None:
                return self._picam.capture_array()
            if self._cv is not None:
                ok, frame = self._cv.read()
                return frame if ok else None
        except Exception:
            pass
        return None
