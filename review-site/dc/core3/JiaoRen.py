# coding: utf-8
"""
JiaoRen —— 蛟人半潜器自主巡航 · 实物入口（树莓派 Zero 2W）
==========================================================
结构沿用 学森挑战营代码\\JiaoRen\\Version_2\\JiaoRen.py 的
"入口起多线程 + Lib 类库"组织方式：

    传感器流线程  IMU 100Hz / 深度计 25Hz  →  共享测量缓存
    视觉线程      相机取帧 → detect() 检测前端（阶段二模型接入点）
    控制主循环    100Hz：融合 → 决策(20Hz) → 控制 → 执行器
    控制台线程    S 开始 / P 暂停 / Q 退出

与仿真共用同一套 Lib\\ 算法（sim_entry.py 只是接线不同）——
在网页/数字水池里验证的就是装机运行的这份代码。
无硬件环境自动干跑（Mock 执行器 + 无传感器则等待）。

用法：  python3 JiaoRen.py            # 航点读 任务航点.json（没有则用内置示例）
"""
import json
import math
import os
import sys
import threading
import time

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from Lib.Params import *
from Lib.Sensors import IMU_JY901, DepthMS5837, MonoCamera
from Lib.Actuators import Actuators
from Lib.StateEstimation import StateEstimator
from Lib.Vision import VisionTracker
from Lib.Guidance import Mission
from Lib.Control import Controller

# ---------------- 任务配置 ----------------
DEFAULT_WPS = [[7, 2.5, 0.5], [13, 7.2, 1.4], [21, 3.0, 0.6],
               [28, 7.0, 1.5], [35, 5.0, 0.8]]
WIDTH = 10.0


def load_waypoints():
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), '任务航点.json')
    if os.path.exists(p):
        with open(p, encoding='utf-8') as f:
            cfg = json.load(f)
        return cfg.get('waypoints', DEFAULT_WPS), cfg.get('width', WIDTH)
    return DEFAULT_WPS, WIDTH


def detect(frame):
    """视觉检测前端（阶段二接入点）：输入相机帧，输出体轴系检测
    [{'rg','brg','type','r','draft','full'}, ...]。
    装机时接 OpenCV/检测模型；当前占位返回空。"""
    return []


class JiaoRen:
    def __init__(self):
        wps, width = load_waypoints()
        self.imu_dev = IMU_JY901()
        self.dep_dev = DepthMS5837()
        self.cam_dev = MonoCamera()
        self.act = Actuators()
        self.est = StateEstimator()
        self.vision = VisionTracker()
        self.mission = Mission(wps, width=width, start_z=0.4, loop=False)
        self.ctrl = Controller()
        self.running = True
        self.lock = threading.Lock()
        self.meas = {'imu': None, 'depth': None, 'dets': None}
        print('== 蛟人自主巡航 ==  IMU:%s 深度计:%s 相机:%s 执行器:%s' % (
            '√' if self.imu_dev.available() else '×（干跑）',
            '√' if self.dep_dev.available() else '×',
            '√' if self.cam_dev.available() else '×',
            '实物' if self.act.real else 'Mock'))
        print('航点 %d 个：%s' % (len(wps), wps))

    # ---------------- 线程体 ----------------
    def sensor_stream(self):
        """IMU 100Hz / 深度计 25Hz"""
        n = 0
        while self.running:
            imu = self.imu_dev.read()
            dep = self.dep_dev.read() if n % 4 == 0 else None
            with self.lock:
                if imu:
                    self.meas['imu'] = imu
                if dep:
                    self.meas['depth'] = dep
            n += 1
            time.sleep(1.0 / RATE_CTRL)

    def vision_stream(self):
        """相机 → detect() → 检测缓存（RATE_VISION Hz）"""
        while self.running:
            frame = self.cam_dev.read()
            dets = detect(frame) if frame is not None else None
            with self.lock:
                self.meas['dets'] = dets
            time.sleep(1.0 / RATE_VISION)

    def control_loop(self):
        """100Hz：融合 → 决策(20Hz) → 控制 → 执行器"""
        dt = 1.0 / RATE_CTRL
        next_dec = 0.0
        t0 = time.time()
        while self.running:
            t = time.time() - t0
            with self.lock:
                imu = self.meas['imu']
                dep = self.meas['depth']
                dets = self.meas['dets']
                self.meas['dets'] = None       # 每帧只消费一次
            # 实物定位：VO/SLAM 输出接入点（阶段二 ORB-SLAM3+深度尺度锚）。
            # 未接入时航位推算自持（有界漂移由深度锚+回航点修正兜底）
            vo = None
            self.est.update(imu, dep, vo, dt)
            if dets is not None:
                self.vision.tick(dets, self.est, t, 1.0 / RATE_VISION)
            if t >= next_dec:
                self.mission.tick(self.vision.confirmed(), self.est, 1.0 / RATE_DECIDE)
                next_dec = t + 1.0 / RATE_DECIDE
            cmd = self.ctrl.tick(self.est, self.mission, dt)
            self.act.apply(cmd)
            for ev in self.vision.pop_events() + self.mission.pop_events():
                print('[%6.1fs] %s' % (t, ev.replace('<b>', '').replace('</b>', '')))
            time.sleep(max(0.0, dt - ((time.time() - t0) - t)))

    def console(self):
        print('指令：S 开始任务 | P 暂停(回待命) | Q 退出')
        while self.running:
            try:
                cmd = input().strip().upper()
            except EOFError:
                break
            if cmd == 'S':
                self.mission.start(self.est)
            elif cmd == 'P':
                self.mission.state = 'IDLE'
                self.act.stop()
                print('已暂停，回待命')
            elif cmd == 'Q':
                self.running = False

    def run(self):
        threads = [threading.Thread(target=self.sensor_stream, daemon=True),
                   threading.Thread(target=self.vision_stream, daemon=True),
                   threading.Thread(target=self.control_loop, daemon=True),
                   threading.Thread(target=self.console, daemon=True)]
        for th in threads:
            th.start()
        try:
            while self.running:
                time.sleep(0.2)
        except KeyboardInterrupt:
            print('\n手动中断')
        finally:
            self.running = False
            time.sleep(0.1)
            self.act.stop()


if __name__ == '__main__':
    JiaoRen().run()
