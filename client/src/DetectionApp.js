import React, { useEffect, useState } from "react";

export default function DetectionApp() {
  const [imageSrc, setImageSrc] = useState(null);
  const [detections, setDetections] = useState([]);
  const [ws, setWs] = useState(null);

  useEffect(() => {
    // Connect to WebSocket
    const websocket = new WebSocket("ws://localhost:7001/ws");

    websocket.onopen = () => console.log("Connected to CV Service WebSocket");

    websocket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.image) setImageSrc(`data:image/jpeg;base64,${msg.image}`);
        if (msg.detections) setDetections(msg.detections);
      } catch (err) {
        console.error("Invalid WS message:", event.data);
      }
    };

    setWs(websocket);
    return () => websocket.close();
  }, []);

  // Upload image to /detect endpoint
  const handleUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);

    try {
      await fetch("http://localhost:7001/detect", {
        method: "POST",
        body: formData,
      });
      // No need to handle response; WebSocket will update image/detections
    } catch (err) {
      console.error("Upload failed:", err);
    }
  };

  return (
    <div style={{ padding: "20px", fontFamily: "Arial, sans-serif" }}>
      <h2>📡 AI/ML Real-Time Messaging System</h2>

      <input type="file" accept="image/*" onChange={handleUpload} />

      {imageSrc ? (
        <div style={{ marginTop: "20px" }}>
          <h3>Detection Image:</h3>
          <img
            src={imageSrc}
            alt="Detection"
            style={{ maxWidth: "600px", border: "2px solid black" }}
          />
        </div>
      ) : (
        <p>Messages detected by Computer Vision service will appear here.</p>
      )}

      {detections.length > 0 && (
        <div>
          <h3>Detections:</h3>
          <ul>
            {detections.map((det, i) => (
              <li key={i}>
                {det.class} ({(det.conf * 100).toFixed(1)}%)
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
