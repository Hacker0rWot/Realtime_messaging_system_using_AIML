# main.py
import io
import base64
import uuid
import time
import asyncio
from typing import List, Dict, Tuple

from fastapi import FastAPI, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image
import numpy as np
import uvicorn
import json
import os
from fastapi.staticfiles import StaticFiles

# ultralytics YOLOv8
from ultralytics import YOLO

# cryptography AES-GCM
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# load YOLOv8n model (small & fast)
detector = YOLO("yolov8n.pt")  # first run will download weights

# -------------------------
# tiny IoU tracker for demo
# -------------------------
def iou(boxA: Tuple[int,int,int,int], boxB: Tuple[int,int,int,int]) -> float:
    xA = max(boxA[0], boxB[0])
    yA = max(boxA[1], boxB[1])
    xB = min(boxA[2], boxB[2])
    yB = min(boxA[3], boxB[3])
    interW = max(0, xB - xA)
    interH = max(0, yB - yA)
    interArea = interW * interH
    if interArea == 0:
        return 0.0
    boxAArea = (boxA[2]-boxA[0])*(boxA[3]-boxA[1])
    boxBArea = (boxB[2]-boxB[0])*(boxB[3]-boxB[1])
    return interArea / float(boxAArea + boxBArea - interArea)

class SimpleTracker:
    def __init__(self, iou_threshold=0.35, max_lost=5):
        self.iou_threshold = iou_threshold
        self.max_lost = max_lost
        self.tracks = {}  # id -> {"bbox":(x1,y1,x2,y2), "label":str, "lost":int}

    def update(self, detections: List[Dict]) -> List[Dict]:
        assigned = {}
        dets = [tuple(d["bbox"]) for d in detections]
        labels = [d.get("class","") for d in detections]
        track_ids = list(self.tracks.keys())

        if track_ids and dets:
            iou_matrix = np.zeros((len(track_ids), len(dets)), dtype=float)
            for i, tid in enumerate(track_ids):
                for j, db in enumerate(dets):
                    iou_matrix[i, j] = iou(self.tracks[tid]["bbox"], db)

            used_t, used_d = set(), set()
            while True:
                if iou_matrix.size == 0:
                    break
                idx = np.unravel_index(np.argmax(iou_matrix, axis=None), iou_matrix.shape)
                i, j = idx
                if iou_matrix[i, j] < self.iou_threshold:
                    break
                tid = track_ids[i]
                self.tracks[tid]["bbox"] = dets[j]
                self.tracks[tid]["label"] = labels[j]
                self.tracks[tid]["lost"] = 0
                assigned[j] = tid
                used_t.add(i); used_d.add(j)
                iou_matrix[i, :] = -1
                iou_matrix[:, j] = -1
        else:
            used_t, used_d = set(), set()

        # create new tracks for unmatched detections
        for j, det in enumerate(dets):
            if j in assigned: continue
            new_id = str(uuid.uuid4())
            self.tracks[new_id] = {"bbox": det, "label": labels[j], "lost": 0}
            assigned[j] = new_id

        # increase lost count for unmatched tracks
        for i, tid in enumerate(track_ids):
            if i not in used_t:
                self.tracks[tid]["lost"] += 1

        # remove old tracks
        remove = [tid for tid, t in self.tracks.items() if t["lost"] > self.max_lost]
        for tid in remove:
            del self.tracks[tid]

        out = []
        for j, det in enumerate(detections):
            tid = assigned[j]
            out.append({
                "object_id": tid,
                "bbox": det["bbox"],
                "class": det.get("class"),
                "conf": det.get("conf")
            })
        return out

tracker = SimpleTracker(iou_threshold=0.35, max_lost=5)

# -------------------------
# WS clients + broadcast helper
# -------------------------
clients: List[WebSocket] = []

async def broadcast(payload: Dict):
    for c in clients.copy():
        try:
            await c.send_json(payload)
        except Exception:
            try:
                clients.remove(c)
            except:
                pass

# -------------------------
# detection encryption key (generated on startup)
# -------------------------
# NOTE: For a production multi-client secure system you'd distribute per-client keys via a secure channel.
# For this demo we generate a single detection AES key and print it so clients can copy it (simple).
DETECTION_KEY = AESGCM.generate_key(bit_length=256)  # 256-bit AES key
DETECTION_KEY_B64 = base64.b64encode(DETECTION_KEY).decode()
with open("detection_key.txt", "w") as f:
    f.write(DETECTION_KEY_B64)

app.mount("/static", StaticFiles(directory="."), name="static")

aesgcm = AESGCM(DETECTION_KEY)

print("=== CV SERVICE: detection AES key (base64) ===")
print(DETECTION_KEY_B64)
print("=== copy this key into App.js constant DETECTION_KEY_B64 ===")

def encrypt_detection_payload(obj: dict) -> Dict:
    try:
        iv = os.urandom(12)
        raw = json.dumps(obj).encode("utf-8")
        ct = aesgcm.encrypt(iv, raw, None)
        return {"ciphertext_b64": base64.b64encode(ct).decode(), "iv_b64": base64.b64encode(iv).decode()}
    except Exception as e:
        print("encrypt_detection_payload error:", e)
        return {"error":"encrypt_failed"}

# -------------------------
# WebSocket for frontends to RECEIVE detection broadcasts
# -------------------------
@app.websocket("/ws")
async def ws_broadcast(ws: WebSocket):
    await ws.accept()
    clients.append(ws)
    try:
        await ws.send_json({"type":"info","message":"connected to CV WS"})
        while True:
            # keepalive (client may send pings)
            try:
                _ = await ws.receive_text()
            except WebSocketDisconnect:
                break
            except Exception:
                await asyncio.sleep(0.1)
    finally:
        try:
            clients.remove(ws)
        except:
            pass

# -------------------------
# WebSocket for frontend to SEND frames (base64 dataURL or base64 string)
# -------------------------
@app.websocket("/ws_frames")
async def ws_frames(ws: WebSocket):
    await ws.accept()
    print("ws_frames: client connected")
    try:
        while True:
            data = await ws.receive_text()
            if data.startswith("data:"):
                b64 = data.split(",", 1)[1]
            else:
                b64 = data
            try:
                img_bytes = base64.b64decode(b64)
                np_arr = np.frombuffer(img_bytes, np.uint8)
                # decode with cv2 (import here to delay heavy import if not used)
                import cv2
                frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
                if frame is None:
                    continue
                # convert BGR -> RGB PIL
                pil = Image.fromarray(frame[..., ::-1])
                results = detector(pil, conf=0.25)[0]
                detections = []
                for box, cls, conf in zip(results.boxes.xyxy.cpu().numpy(),
                                          results.boxes.cls.cpu().numpy(),
                                          results.boxes.conf.cpu().numpy()):
                    x1,y1,x2,y2 = map(int, box.astype(int).tolist())
                    label = results.names[int(cls)]
                    detections.append({"bbox":[x1,y1,x2,y2], "class": label, "conf": float(conf)})

                # track & get stable ids
                tracked = tracker.update(detections)

                # broadcast encrypted detection payload to all WS clients
                payload = {"type":"detection_broadcast_enc", "ts": time.time(), "detections": tracked}
                enc = encrypt_detection_payload(payload)
                await broadcast({"type":"detection_broadcast_enc", "data": enc, "ts": payload["ts"]})

            except Exception as e:
                print("frame processing error:", e)
                # don't crash; continue listening
    except WebSocketDisconnect:
        print("ws_frames: client disconnected")
    except Exception as e:
        print("ws_frames error:", e)

# keep POST /detect for backwards compatibility (optional)
@app.post("/detect")
async def detect(file: UploadFile):
    image_bytes = await file.read()
    pil = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    results = detector(pil, conf=0.25)[0]

    detections = []
    for box, cls, conf in zip(results.boxes.xyxy.cpu().numpy(),
                              results.boxes.cls.cpu().numpy(),
                              results.boxes.conf.cpu().numpy()):
        x1,y1,x2,y2 = map(int, box.astype(int).tolist())
        label = results.names[int(cls)]
        detections.append({"bbox":[x1,y1,x2,y2], "class": label, "conf": float(conf)})

    tracked = tracker.update(detections)
    payload = {"type":"detection_broadcast_enc", "ts": time.time(), "detections": tracked}
    enc = encrypt_detection_payload(payload)
    await broadcast({"type":"detection_broadcast_enc", "data": enc, "ts": payload["ts"]})
    return JSONResponse({"status":"ok","encrypted":enc})

@app.get("/health")
async def health():
    return {"status":"ok"}

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=7001, reload=True)
