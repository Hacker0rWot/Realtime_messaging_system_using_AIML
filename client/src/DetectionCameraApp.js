import React, { useEffect, useRef, useState } from "react";

export default function DetectionCameraApp() {
  const videoRef = useRef(null);
  const wsRef = useRef(null);
  const [imageSrc, setImageSrc] = useState(null);
  const [detections, setDetections] = useState([]);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");

  // ------------------------
  // Initialize WebSocket
  // ------------------------
  useEffect(() => {
    const ws = new WebSocket("ws://localhost:7001/ws");
    wsRef.current = ws;

    ws.onopen = () => console.log("Connected to CV Service WebSocket");

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        // Update image + detections
        if (msg.image) setImageSrc(`data:image/jpeg;base64,${msg.image}`);
        if (msg.detections) setDetections(msg.detections);

        // Update messages if type=="chat"
        if (msg.type === "chat") {
          setMessages((prev) => [...prev, msg]);
        }
      } catch (err) {
        console.error("Invalid WS message:", event.data);
      }
    };

    return () => ws.close();
  }, []);

  // ------------------------
  // Access camera
  // ------------------------
  useEffect(() => {
    navigator.mediaDevices.getUserMedia({ video: true })
      .then((stream) => {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      })
      .catch(console.error);
  }, []);

  // ------------------------
  // Capture frame every 1 sec
  // ------------------------
  useEffect(() => {
    const interval = setInterval(() => {
      if (!videoRef.current) return;
      const canvas = document.createElement("canvas");
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(videoRef.current, 0, 0);
      canvas.toBlob(async (blob) => {
        if (!blob) return;
        const formData = new FormData();
        formData.append("file", blob, "frame.jpg");
        try {
          await fetch("http://localhost:7001/detect", {
            method: "POST",
            body: formData,
          });
        } catch (err) {
          console.error("Upload failed:", err);
        }
      }, "image/jpeg");
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // ------------------------
  // Send chat message
  // ------------------------
  const sendMessage = () => {
    if (text.trim() && wsRef.current) {
      wsRef.current.send(JSON.stringify({ type: "chat", message: text }));
      setText("");
    }
  };

  return (
    <div style={{ padding: "20px", fontFamily: "Arial, sans-serif" }}>
      <h2>📡 AI/ML Real-Time Messaging System</h2>

      <video ref={videoRef} style={{ width: "400px", border: "2px solid black" }} />

      {imageSrc && (
        <div style={{ marginTop: "20px" }}>
          <h3>Detection Image:</h3>
          <img
            src={imageSrc}
            alt="Detection"
            style={{ maxWidth: "600px", border: "2px solid red" }}
          />
        </div>
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

      <div style={{ marginTop: "20px" }}>
        <h3>Messages:</h3>
        <ul>
          {messages.map((m, i) => (
            <li key={i}>{m.message}</li>
          ))}
        </ul>

        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a message..."
        />
        <button onClick={sendMessage}>Send</button>
      </div>
    </div>
  );
}
