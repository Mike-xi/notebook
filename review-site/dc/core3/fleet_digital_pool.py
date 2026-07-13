# coding: utf-8
"""Stage-three offline digital pool driven by the phase-one 5-DOF vehicle."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
SIM_ROOT = ROOT / "\u9636\u6bb5\u4e00\u4e8c_\u5efa\u6a21\u63a7\u5236\u4e0e\u591a\u6a21\u6001\u611f\u77e5" / "\u4eff\u771f"
if str(SIM_ROOT) not in sys.path:
    sys.path.insert(0, str(SIM_ROOT))

from jiaoren_sim.pool import Pool
from jiaoren_sim.vehicle import SemiSub


class FleetDigitalPool:
    """One phase-one SemiSub model per agent; every vehicle shares the flow setup."""

    def __init__(self, n, length=42.0, width=14.0, depth=2.2, current=(0.0, 0.0), gust_amp=0.0):
        self.pools = [Pool(length, width, depth, current, gust_amp) for _ in range(n)]
        self.vehicles = [SemiSub(pool) for pool in self.pools]
        self.states = [SemiSub.initial_state() for _ in range(n)]

    def reset(self, poses):
        for i, (x, y, z, psi) in enumerate(poses):
            self.states[i] = SemiSub.initial_state(x, y, z, psi)
            self.vehicles[i].TL = self.vehicles[i].TR = 0.0

    @staticmethod
    def _rk4(vehicle, state, command, t, dt):
        f = vehicle.derivatives
        k1 = f(state, command, t)
        k2 = f([v + dt * d / 2 for v, d in zip(state, k1)], command, t + dt / 2)
        k3 = f([v + dt * d / 2 for v, d in zip(state, k2)], command, t + dt / 2)
        k4 = f([v + dt * d for v, d in zip(state, k3)], command, t + dt)
        nxt = [v + dt * (a + 2 * b + 2 * c + d) / 6 for v, a, b, c, d in zip(state, k1, k2, k3, k4)]
        d_tl, d_tr = vehicle._dT
        vehicle.TL += d_tl * dt
        vehicle.TR += d_tr * dt
        return vehicle.pool.constrain(nxt, t + dt)

    def step(self, commands, t, dt):
        for i, command in enumerate(commands):
            self.states[i] = self._rk4(self.vehicles[i], self.states[i], command, t, dt)

    def sensors(self):
        imu, depth, vo = [], [], []
        for s in self.states:
            imu.append({"yaw": s[4], "pitch": s[3], "q": s[8], "r": s[9]})
            depth.append({"depth": s[2]})
            vo.append({"x": s[0], "y": s[1], "vx": s[5], "vy": s[6]})
        return imu, depth, vo
