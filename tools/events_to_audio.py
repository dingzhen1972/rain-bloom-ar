"""Soundtrack for an offline demo render, synthesised from the effect's event log.
   python3 tools/events_to_audio.py out/clip.events.json out/clip.wav
Needs numpy + scipy. Rain bed, a soft chime per "ha", a sub drop + crackle on ignition, whistles and booms for shells."""
import json, sys
import numpy as np
from scipy import signal
from scipy.io import wavfile

ev_path, out_path = sys.argv[1], sys.argv[2]
D = json.load(open(ev_path))
SR = 48000
dur = D["total"] / D["fps"]
N = int(SR * dur)
rng = np.random.default_rng(3)
L = np.zeros(N); R = np.zeros(N)

def place(x, t, pan=0.0, g=1.0):
    i = int(t * SR)
    if i >= N: return
    x = x[: N - i] * g
    L[i:i + len(x)] += x * np.cos((pan + 1) * np.pi / 4); R[i:i + len(x)] += x * np.sin((pan + 1) * np.pi / 4)
def filt(x, kind, f): b, a = signal.butter(2, np.array(f) / (SR / 2), kind); return signal.lfilter(b, a, x)
def env(n, a, d): t = np.arange(n) / SR; return np.minimum(t / max(a, 1e-4), 1) * np.exp(-t / d)

ign = [e["t"] for e in D["events"] if e["type"] == "ignite"]
t_ign = ign[0] if ign else 1e9
tt = np.arange(N) / SR
level = np.interp(tt, [0, t_ign, t_ign + 0.2, t_ign + 2.0, t_ign + 5.5, dur], [0.8, 0.8, 0.25, 0.3, 0.75, 0.75]) if ign else np.full(N, 0.8)
level *= np.minimum(1, tt / 0.6)
for c, arr in ((0, L), (1, R)):
    arr += filt(rng.standard_normal(N), "band", [900, 8500]) * 0.11 * level
for _ in range(int(dur * 70)):
    t = rng.uniform(0, dur); n = int(SR * 0.025); f = rng.uniform(2000, 5000)
    place(np.sin(2 * np.pi * f * np.arange(n) / SR) * env(n, 0.0005, 0.005), t, rng.uniform(-0.9, 0.9), rng.uniform(0.02, 0.06) * np.interp(t, tt[::480], level[::480]))

PENTA = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5]
def bell(f, d=1.6):
    n = int(SR * d); t = np.arange(n) / SR
    return (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t * 6)) * env(n, 0.003, d / 3)
def crackle(t0, d, cnt, pan):
    for _ in range(cnt):
        t = t0 + rng.uniform(0, d) * rng.uniform(0.3, 1); n = int(SR * 0.012)
        place(filt(rng.standard_normal(n), "high", 3000) * env(n, 0.0003, 0.002), t, pan + rng.uniform(-0.4, 0.4), rng.uniform(0.04, 0.15))

k = 0
for e in D["events"]:
    t, ty = e["t"], e["type"]; pan = float(np.clip(e.get("x", 0.5) * 2 - 1, -1, 1))
    if ty == "pulse":
        place(bell(PENTA[k % 4] / 2, 1.4), t, pan, 0.16); k += 1
        n = int(SR * 0.5); place(filt(rng.standard_normal(n), "band", [600, 3000]) * np.sin(np.pi * np.arange(n) / n) ** 2, t, 0, 0.08)
    elif ty == "ignite":
        n = int(SR * 2.6); t2 = np.arange(n) / SR
        sub = np.sin(2 * np.pi * np.cumsum(90 * np.exp(-t2 * 3) + 36) / SR) * env(n, 0.003, 0.8)
        air = filt(rng.standard_normal(n), "high", 2500) * env(n, 0.002, 0.25) * 0.5
        place(sub + air, t, 0, 0.8)
        crackle(t + 0.08, 2.6, 700, 0)
        for j, f in enumerate([PENTA[0], PENTA[2], PENTA[4]]): place(bell(f / 2, 2.6), t + j * 0.04, 0, 0.1)
        # riser into the laugh
        n = int(SR * 1.0); x = np.arange(n) / n
        place(filt(rng.standard_normal(n), "band", [400, 6000]) * x ** 2.5, max(0, t - 1.0), 0, 0.25)
    elif ty == "launch":
        n = int(SR * 0.75); x = np.arange(n) / n
        wh = np.sin(2 * np.pi * np.cumsum(800 + 1600 * x) / SR) * x ** 0.5 * (1 - x) * 0.25
        place(wh + filt(rng.standard_normal(n), "band", [2000, 8000]) * (1 - x) * 0.25, t, pan, 0.25)
    elif ty == "burst":
        s = e.get("size", 1); n = int(SR * 3); t2 = np.arange(n) / SR
        boom = filt(rng.standard_normal(n), "low", 170 + 90 * s) * env(n, 0.004, 0.5 + 0.25 * s) * 5
        crack = filt(rng.standard_normal(n), "band", [800, 6000]) * env(n, 0.001, 0.08)
        place(boom + crack, t, pan, 0.45 * min(1.3, s)); place(filt(boom, "low", 400) * 0.3, t + 0.22, -pan, 0.3)
        if e.get("kind") != "peony": crackle(t + 0.3, 1.6, 160, pan)
        place(bell(PENTA[rng.integers(0, 6)], 2.2), t, pan, 0.05)

def reverb(x, d=1.5, mix=0.2):
    n = int(SR * d); ir = filt(rng.standard_normal(n) * np.exp(-np.arange(n) / SR * 4.5 / d), "low", 6000); ir /= np.sqrt((ir ** 2).sum())
    return x + signal.fftconvolve(x, ir)[: len(x)] * mix
L, R = reverb(L), reverb(R)
fade = np.ones(N); f = int(SR * 0.5); fade[-f:] = np.linspace(1, 0, f)
mx = np.stack([L * fade, R * fade], 1)
mx = np.tanh(mx / (np.abs(mx).max() * 0.55 + 1e-9) * 1.1) * 0.89
wavfile.write(out_path, SR, (mx * 32767).astype(np.int16))
print("wrote", out_path, f"{dur:.2f}s")
