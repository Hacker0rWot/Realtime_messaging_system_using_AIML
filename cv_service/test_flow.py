import asyncio
import websockets
import requests

# URLS
HTTP_URL = "http://localhost:7001/detect"
WS_URL = "ws://localhost:7001/ws"

async def run_test():
    # 1. Connect to WebSocket
    async with websockets.connect(WS_URL) as websocket:
        print("✅ Connected to WebSocket")

        # 2. Upload an image to /detect (trigger detection)
        with open("sample.jpg", "rb") as f:   # <-- put an image in cv_service/
            files = {"file": ("sample.jpg", f, "image/jpeg")}
            r = requests.post(HTTP_URL, files=files)

        print("📤 Sent image to /detect, response:", r.json())

        # 3. Wait for a message from WebSocket
        msg = await websocket.recv()
        print("📡 Received from WebSocket:", msg)

if __name__ == "__main__":
    asyncio.run(run_test())
