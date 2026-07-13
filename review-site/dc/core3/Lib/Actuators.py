# coding: utf-8
"""
Actuators —— 实物执行器输出（双桨差速 + 尾舵 + 注射器压载）
============================================================
指令来源：Control.tick() 的 (nL, nR, delta, s_cmd)
  nL/nR ∈ [-1,1]   → Board.setMotor(通道, ±100)      （同 PadControl.py）
  delta [rad]      → 尾舵舵机脉宽 1500±500µs ↔ ±90°
  s_cmd ∈ [0,1]    → 注射器压载舵机脉宽（通道待装机核对）
无 Board 库（非树莓派）时降级为 MockBoard，只打印不出力 —— 便于台架前
在 PC 上跑通整条"感知-决策-控制"链路。
"""
from .Params import *

try:
    import Board as _Board          # Hiwonder 扩展板驱动（学森营同款）
except Exception:
    _Board = None


class _MockBoard:
    def setMotor(self, ch, val):
        pass

    def setPWMServoPulse(self, ch, pulse, ms):
        pass


class Actuators:
    def __init__(self, verbose=False):
        self.board = _Board if _Board is not None else _MockBoard()
        self.real = _Board is not None
        self.verbose = verbose
        self._servo_div = 0

    def apply(self, cmd):
        nl, nr, delta, s_cmd = cmd
        self.board.setMotor(MOTOR_CH_L, int(clamp(nl, -1, 1) * MOTOR_MAX))
        self.board.setMotor(MOTOR_CH_R, int(clamp(nr, -1, 1) * MOTOR_MAX))
        # 舵机指令降频下发（串口带宽有限，同 PadControl.py 的 1/6 分频）
        self._servo_div = (self._servo_div + 1) % 6
        if self._servo_div == 0:
            pulse = int(RUDDER_CENTER + RUDDER_SPAN * clamp(delta, -RUDDER_FULL, RUDDER_FULL) / RUDDER_FULL)
            self.board.setPWMServoPulse(RUDDER_CH, pulse, 60)
            bal = int(BALLAST_MIN + (BALLAST_MAX - BALLAST_MIN) * clamp(s_cmd, 0, 1))
            self.board.setPWMServoPulse(BALLAST_CH, bal, 60)
        if self.verbose:
            print('[ACT] L=%+.2f R=%+.2f δ=%+5.1f° 注水=%3.0f%%'
                  % (nl, nr, delta * R2D, s_cmd * 100))

    def stop(self):
        self.apply((0.0, 0.0, 0.0, 0.5))
