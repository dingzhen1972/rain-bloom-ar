"""Real face + person analysis of a clip, for offline demo renders.
Uses MediaPipe's own models (BlazeFace short-range, FaceMesh 468 landmarks, Selfie Segmentation) through OpenCV DNN,
so the test renders are driven by actual detection rather than hand-placed numbers.

  python3 tools/analyze_clip.py <framesDir> <modelsDir> <out_signals.json>

Per frame it writes: portrait crop window, face box / mouth in output coordinates, the person's top outline (72 columns),
and the raw expression signals (smile, jaw) that the web app's LaughController consumes."""
import cv2, json, sys, glob, math
import numpy as np
from scipy.ndimage import median_filter, uniform_filter1d

frames_dir, models_dir, out_path = sys.argv[1:4]
det = cv2.dnn.readNetFromTFLite(f'{models_dir}/face_detection_short_range.tflite')
mesh = cv2.dnn.readNetFromTFLite(f'{models_dir}/face_landmark.tflite')
seg = cv2.dnn.readNetFromTFLite(f'{models_dir}/selfie_segmentation.tflite')
NCOL = 72

# ---- BlazeFace anchors (short range, 128x128) ----
anchors = []
for stride, per in ((8, 2), (16, 6)):
    fm = 128 // stride
    for y in range(fm):
        for x in range(fm):
            for _ in range(per): anchors.append(((x + 0.5) / fm, (y + 0.5) / fm))
anchors = np.array(anchors)

def detect(img, roi):
    """roi: (cx, cy, size) square in source pixels. Returns best face (box, keypoints, score) in source pixels."""
    cx, cy, s = roi; x0, y0 = int(cx - s / 2), int(cy - s / 2)
    M = np.array([[128 / s, 0, -x0 * 128 / s], [0, 128 / s, -y0 * 128 / s]], np.float32)
    patch = cv2.warpAffine(img, M, (128, 128), borderMode=cv2.BORDER_CONSTANT)
    blob = cv2.dnn.blobFromImage(patch[:, :, ::-1].astype(np.float32) / 127.5 - 1.0)
    det.setInput(blob); reg = det.forward('regressors')[0]
    det.setInput(blob); cls = det.forward('classificators')[0][:, 0]
    sc = 1 / (1 + np.exp(-np.clip(cls, -80, 80)))
    i = int(np.argmax(sc))
    if sc[i] < 0.5: return None
    # weighted blend of overlapping candidates (MediaPipe-style)
    good = np.where(sc > 0.5)[0]
    def box(k):
        r = reg[k] / 128.0; ax, ay = anchors[k]
        return np.array([r[0] + ax, r[1] + ay, r[2], r[3]] + [v for j in range(6) for v in (r[4 + 2 * j] + ax, r[5 + 2 * j] + ay)])
    b0 = box(i); acc = np.zeros(16); wsum = 0
    for k in good:
        b = box(k)
        if abs(b[0] - b0[0]) < b0[2] * 0.5 and abs(b[1] - b0[1]) < b0[3] * 0.5: acc += b * sc[k]; wsum += sc[k]
    b = acc / wsum
    pts = b.reshape(-1, 2) * s + [x0, y0]          # centre, size, 6 keypoints → source px
    return dict(cx=pts[0][0], cy=pts[0][1], w=b[2] * s, h=b[3] * s, kp=pts[2:], score=float(sc[i]))

def landmarks(img, f):
    # rotation from the eyes (kp0 = right eye, kp1 = left eye), crop 1.5x the face like MediaPipe
    (rx, ry), (lx, ly) = f['kp'][0], f['kp'][1]
    ang = math.atan2(ly - ry, lx - rx)
    size = max(f['w'], f['h']) * 1.5
    c, s_ = math.cos(ang), math.sin(ang)
    k = 192 / size
    # source → crop: rotate by -ang around face centre, scale, translate to 96,96
    M = np.array([[c * k, s_ * k, 0], [-s_ * k, c * k, 0]], np.float32)
    M[:, 2] = np.array([96, 96]) - M[:, :2] @ np.array([f['cx'], f['cy']])
    patch = cv2.warpAffine(img, M, (192, 192), borderMode=cv2.BORDER_REPLICATE)
    mesh.setInput(cv2.dnn.blobFromImage(patch[:, :, ::-1].astype(np.float32) / 255.0))
    lm = mesh.forward('conv2d_21').reshape(-1, 3)[:, :2]
    Mi = cv2.invertAffineTransform(M)
    return lm @ Mi[:, :2].T + Mi[:, 2]

def segment(crop):
    h, w = crop.shape[:2]; S = max(h, w)
    sq = np.zeros((S, S, 3), np.uint8); ox = (S - w) // 2; sq[:, ox:ox + w] = crop
    seg.setInput(cv2.dnn.blobFromImage(cv2.resize(sq, (256, 256))[:, :, ::-1].astype(np.float32) / 255.0))
    m = cv2.resize(seg.forward()[0, 0], (S, S))[:, ox:ox + w]
    return m

files = sorted(glob.glob(f'{frames_dir}/*.jpg'))
img0 = cv2.imread(files[0]); SH, SW = img0.shape[:2]
CW = SH * 9 / 16
raw = []; roi = (SW / 2, SH * 0.45, SH * 0.8); miss = 0
for fpath in files:
    img = cv2.imread(fpath)
    f = detect(img, roi)
    if f is None:
        f2 = detect(img, (SW / 2, SH / 2, SH))            # full-frame retry
        f = f2
    if f is None:
        miss += 1; raw.append(None)
        if miss > 5: roi = (SW / 2, SH * 0.45, SH * 0.8)
        continue
    miss = 0
    roi = (f['cx'], f['cy'], max(f['w'], f['h']) * 3.0)
    L = landmarks(img, f)
    fw = np.linalg.norm(L[234] - L[454]); fh = np.linalg.norm(L[10] - L[152])
    gap = np.linalg.norm(L[13] - L[14]) / fh
    mw = np.linalg.norm(L[61] - L[291]) / fw
    lift = (((L[13][1] + L[14][1]) / 2) - ((L[61][1] + L[291][1]) / 2)) / fh   # corners above the lip centre
    x0, y0 = L.min(0); x1, y1 = L.max(0)
    raw.append(dict(cx=float(f['cx']), cy=float(f['cy']), gap=float(gap), mw=float(mw), lift=float(lift),
                    mouth=[float((L[13][0] + L[14][0]) / 2), float((L[13][1] + L[14][1]) / 2)], box=[float(x0), float(y0), float(x1 - x0), float(y1 - y0)], score=f['score']))

# fill gaps, smooth the reframing centre
valid = [r for r in raw if r]
first = valid[0]
for i in range(len(raw)):
    if raw[i] is None: raw[i] = dict(raw[i - 1] if i else first, missing=True)
cxs = uniform_filter1d(median_filter(np.array([r['cx'] for r in raw]), 15, mode='nearest'), 21, mode='nearest')

out = []
for i, (fpath, r) in enumerate(zip(files, raw)):
    cropX = float(np.clip(cxs[i] - CW / 2, 0, SW - CW))
    img = cv2.imread(fpath); crop = img[:, int(round(cropX)):int(round(cropX + CW))]
    m = segment(crop); hh, ww = m.shape
    tops = []
    for c in range(NCOL):
        xs = slice(int(c * ww / NCOL), max(int(c * ww / NCOL) + 1, int((c + 1) * ww / NCOL)))
        col = m[:, xs].mean(axis=1); idx = np.where(col > 0.5)[0]
        tops.append(float(idx[0] / hh) if len(idx) else 1.0)
    bx, by, bw, bh = r['box']
    out.append(dict(cropX=round(cropX, 1),
                    mouth=[round((r['mouth'][0] - cropX) / CW, 4), round(r['mouth'][1] / SH, 4)],
                    face=[round((bx + bw / 2 - cropX) / CW, 4), round((by + bh / 2) / SH, 4), round(bw / CW, 4), round(bh / SH, 4)],
                    sil=tops, gap=round(r['gap'], 4), mw=round(r['mw'], 4), lift=round(r['lift'], 4), found=not r.get('missing', False)))
S = np.array([o['sil'] for o in out]); S = median_filter(S, size=(5, 3), mode='nearest'); S = uniform_filter1d(S, 3, axis=0, mode='nearest')
for o, s in zip(out, S): o['sil'] = [round(float(v), 4) for v in s]
json.dump(dict(src=[SW, SH], cropW=CW, frames=out), open(out_path, 'w'))
print(f'{len(out)} frames, face found in {sum(o["found"] for o in out)}')
