/* client/src/App.js */
/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const SIO = io("http://localhost:5000");

// helpers: base64 <-> arraybuffer
function b64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
function arrayBufferToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ECDH (P-256) + AES-GCM helpers
async function generateECDHKeyPair() {
  const kp = await window.crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"]
  );
  const pubRaw = await window.crypto.subtle.exportKey("raw", kp.publicKey);
  const pubB64 = arrayBufferToB64(pubRaw);
  return { keyPair: kp, publicKeyB64: pubB64 };
}
async function importPeerPublicKey(rawB64) {
  const raw = b64ToArrayBuffer(rawB64);
  return window.crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, true, []);
}
async function deriveAESGCMKey(ownKP, peerRawB64) {
  const peerKey = await importPeerPublicKey(peerRawB64);
  const aesKey = await window.crypto.subtle.deriveKey(
    { name: "ECDH", public: peerKey },
    ownKP.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  return aesKey;
}
async function encryptAesGcm(key, plaintext) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plaintext);
  const ct = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
  return { ciphertext: arrayBufferToB64(ct), iv: arrayBufferToB64(iv.buffer) };
}
async function decryptAesGcm(key, ciphertextB64, ivB64) {
  const ivBuf = b64ToArrayBuffer(ivB64);
  const ctBuf = b64ToArrayBuffer(ciphertextB64);
  const plainBuf = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(ivBuf) }, key, ctBuf);
  return new TextDecoder().decode(plainBuf);
}

// ---------- AES helpers for detection decryption ----------
async function importDetectionKeyFromB64(b64) {
  try {
    const raw = b64ToArrayBuffer(b64);
    const key = await window.crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    return key;
  } catch (e) {
    console.error("importDetectionKeyFromB64 failed", e);
    return null;
  }
}

// ---------- App ----------
export default function App() {
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const framesWSRef = useRef(null);
  const detectWSRef = useRef(null);

  const [username, setUsername] = useState("");
  const [peer, setPeer] = useState("");
  const [connected, setConnected] = useState(false);

  const [detections, setDetections] = useState([]);
  const [selected, setSelected] = useState(null);

  const localKeyPairRef = useRef(null);
  const localPubB64Ref = useRef(null);
  const [peerPubMap, setPeerPubMap] = useState({});
  const derivedKeysRef = useRef({});

  const detectionKeyRef = useRef(null);

  const [chats, setChats] = useState({});
  const [input, setInput] = useState("");

  const FRAME_INTERVAL_MS = 500;

  // Init local ECDH key pair
  useEffect(() => {
    (async () => {
      const { keyPair, publicKeyB64 } = await generateECDHKeyPair();
      localKeyPairRef.current = keyPair;
      localPubB64Ref.current = publicKeyB64;
    })();

    (async () => {
      try {
        const res = await fetch("http://localhost:7001/static/detection_key.txt");
        const key = await res.text();
        detectionKeyRef.current = await importDetectionKeyFromB64(key.trim());
        console.log("Detection AES key imported automatically.");
      } catch (e) {
        console.warn("Failed to fetch detection key", e);
      }
    })();
  }, []);

  // Socket.IO handlers
  useEffect(() => {
    SIO.on("connect", () => setConnected(true));
    SIO.on("disconnect", () => setConnected(false));

    SIO.on("message", async (msg) => {
      const { sender, object_id, text_enc, ts } = msg;
      const aesKey = derivedKeysRef.current[sender];
      if (aesKey && text_enc) {
        try {
          const plaintext = await decryptAesGcm(aesKey, text_enc.ciphertext, text_enc.iv);
          setChats(prev => {
            const arr = prev[object_id] ? [...prev[object_id]] : [];
            arr.push({ sender, plaintext, ts: ts || Date.now() });
            return { ...prev, [object_id]: arr };
          });
        } catch {
          setChats(prev => {
            const arr = prev[object_id] ? [...prev[object_id]] : [];
            arr.push({ sender, plaintext: "[decryption_failed]", ts: ts || Date.now() });
            return { ...prev, [object_id]: arr };
          });
        }
      } else {
        setChats(prev => {
          const arr = prev[object_id] ? [...prev[object_id]] : [];
          arr.push({ sender, plaintext: "[encrypted]", ts: ts || Date.now() });
          return { ...prev, [object_id]: arr };
        });
      }
    });

    SIO.on("pubkey_response", async ({ peer, publicKeyB64 }) => {
      if (!publicKeyB64) {
        alert(`Peer "${peer}" is not registered or has not published a key yet.`);
        return;
      }
      setPeerPubMap(prev => ({ ...prev, [peer]: publicKeyB64 }));
      if (localKeyPairRef.current) {
        try {
          const aes = await deriveAESGCMKey(localKeyPairRef.current, publicKeyB64);
          derivedKeysRef.current[peer] = aes;
          SIO.emit("send_pubkey_to", { from: username, to: peer, publicKeyB64: localPubB64Ref.current });
          alert(`Shared key established with ${peer}`);
        } catch (e) {
          console.warn("derive failed", e);
        }
      }
    });

    SIO.on("peer_pubkey", async ({ from, publicKeyB64 }) => {
      setPeerPubMap(prev => ({ ...prev, [from]: publicKeyB64 }));
      if (localKeyPairRef.current) {
        try {
          const aes = await deriveAESGCMKey(localKeyPairRef.current, publicKeyB64);
          derivedKeysRef.current[from] = aes;
          console.log("Derived AES for", from);
        } catch (e) {
          console.warn("derive failed", e);
        }
      }
    });

    return () => {
      SIO.off("connect"); SIO.off("disconnect"); SIO.off("message"); SIO.off("pubkey_response"); SIO.off("peer_pubkey");
    };
  }, []);

  async function handleRegister() {
    if (!username) return alert("Type a username first");
    if (!localPubB64Ref.current) {
      const { keyPair, publicKeyB64 } = await generateECDHKeyPair();
      localKeyPairRef.current = keyPair;
      localPubB64Ref.current = publicKeyB64;
    }
    SIO.emit("register", { username, publicKeyB64: localPubB64Ref.current });
    alert(`Registered as ${username}`);
  }

  async function establishSharedKeyWithPeer() {
    if (!peer) return alert("Set peer username");
    SIO.emit("get_pubkey", { requester: username, peer });
  }

  // Detection WS
  useEffect(() => {
    const ws = new WebSocket("ws://localhost:7001/ws");
    detectWSRef.current = ws;
    ws.onmessage = async (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data.type === "detection_broadcast_enc" && data.data && detectionKeyRef.current) {
          const { ciphertext_b64, iv_b64 } = data.data;
          const plainBuf = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(b64ToArrayBuffer(iv_b64)) },
            detectionKeyRef.current,
            b64ToArrayBuffer(ciphertext_b64)
          );
          const obj = JSON.parse(new TextDecoder().decode(plainBuf));
          setDetections(obj.detections || []);
        } else if (data.type === "detection_broadcast" && data.detections) {
          setDetections(data.detections || []);
        }
      } catch (e) {
        console.warn("Invalid detection data", e);
      }
    };
    return () => ws.close();
  }, []);

  // Frames WS
  useEffect(() => {
    let ws = null, interval = null, mounted = true;
    const startFramesWS = async () => {
      try {
        ws = new WebSocket("ws://localhost:7001/ws_frames");
        framesWSRef.current = ws;
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        interval = setInterval(() => {
          if (!mounted || !videoRef.current || ws.readyState !== WebSocket.OPEN) return;
          const canvas = document.createElement("canvas");
          canvas.width = 320; canvas.height = 240;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(videoRef.current, 0, 0, 320, 240);
          ws.send(canvas.toDataURL("image/jpeg", 0.7));
        }, FRAME_INTERVAL_MS);
      } catch (e) { console.error("frames WS setup failed", e); }
    };
    startFramesWS();
    return () => {
      mounted = false;
      if (interval) clearInterval(interval);
      if (framesWSRef.current) framesWSRef.current.close();
      if (videoRef.current && videoRef.current.srcObject) {
        videoRef.current.srcObject.getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  // Overlay rendering (boxes + messages above selected object)
  useEffect(() => {
    const canvas = overlayRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    let raf;
    const render = () => {
      const w = canvas.width = video.clientWidth || 640;
      const h = canvas.height = video.clientHeight || 480;
      ctx.clearRect(0,0,w,h);

      // Scale from 320x240 to video size
      const sx = w / 320, sy = h / 240;

      for (const d of detections) {
        const [x1,y1,x2,y2] = d.bbox;
        const left = x1*sx, top = y1*sy, width = (x2-x1)*sx, height = (y2-y1)*sy;
        ctx.lineWidth = selected===d.object_id?3:2;
        ctx.strokeStyle = selected===d.object_id?"#34d399":"#f59e0b";
        ctx.strokeRect(left,top,width,height);
        ctx.fillStyle=ctx.strokeStyle;
        ctx.font="14px Inter, Arial";
        ctx.fillText(`${d.class} ${(d.conf*100).toFixed(0)}%`, left+6, top+18);

        if(selected===d.object_id){
          const msgs = chats[selected]||[];
          const last = msgs.slice(-2);
          last.forEach((m, idx)=>{
            const text = m.plaintext || "[encrypted]";
            const bx = left, by = top-20*(last.length-idx);
            const wText = Math.min(300, ctx.measureText(text).width + 12);
            ctx.fillStyle = "rgba(2,6,23,0.9)";
            ctx.fillRect(bx, by-14, wText, 18);
            ctx.fillStyle="#e6eef8";
            ctx.fillText(text, bx+6, by);
          });
        }
      }

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return ()=>cancelAnimationFrame(raf);
  }, [detections, chats, selected]);

  // Click handler for selecting objects
  function handleVideoClick(e){
    const rect = e.target.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const w = e.target.clientWidth || 640;
    const h = e.target.clientHeight || 480;
    const sx = 320 / w, sy = 240 / h;
    let picked = null;
    for(const d of detections){
      const [x1,y1,x2,y2] = d.bbox;
      // Map click to 320x240 space
      const rx = x * sx, ry = y * sy;
      if(rx>=x1 && rx<=x2 && ry>=y1 && ry<=y2){ picked=d.object_id; break; }
    }
    setSelected(picked);
  }

  async function sendMessage(){
    if(!username||!peer) return alert("set username and peer");
    if(!selected) return alert("select an object first");
    if(!input) return;
    const aesKey = derivedKeysRef.current[peer];
    if(!aesKey) return alert("no shared key with peer yet");
    try{
      const enc = await encryptAesGcm(aesKey, input);
      SIO.emit("message", { sender: username, receiver: peer, object_id: selected, text_enc: enc, ts:Date.now() });
      setChats(prev=>{
        const arr = prev[selected]? [...prev[selected]]:[];
        arr.push({ sender:username, plaintext:input, ts:Date.now() });
        return {...prev, [selected]:arr};
      });
      setInput("");
    } catch(e){ console.error("send failed", e); alert("Failed to send message"); }
  }

  // ---------- UI ----------
  return (
    <div
      style={{
        fontFamily: "'Inter', 'Poppins', Arial, sans-serif",
        background: "linear-gradient(135deg, #18181b 0%, #23272f 100%)",
        minHeight: "100vh",
        color: "#f4f4f5",
        padding: 24,
        letterSpacing: 0.1,
      }}
    >
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700&display=swap" rel="stylesheet" />
      <div
        style={{
          maxWidth: 1300,
          margin: "0 auto 32px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "0 8px",
        }}
      >
        <h2
          style={{
            margin: 0,
            fontWeight: 700,
            fontSize: 28,
            color: "#fff",
            letterSpacing: 1,
            textShadow: "0 2px 16px #000a",
          }}
        >
          Real Time Messaging System Using AI/ML
        </h2>
        <div
          style={{
            color: connected ? "#22d3ee" : "#f87171",
            fontWeight: 600,
            fontSize: 16,
            letterSpacing: 1,
            background: connected
              ? "rgba(34,211,238,0.10)"
              : "rgba(248,113,113,0.10)",
            padding: "6px 18px",
            borderRadius: 16,
            boxShadow: "0 2px 12px 0 rgba(34,211,238,0.08)",
          }}
        >
          {connected ? "Online" : "Offline"}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "340px 1fr 370px",
          gap: 24,
          alignItems: "flex-start",
        }}
      >
        {/* Session / controls */}
        <div
          style={{
            background: "rgba(36,37,46,0.98)",
            backdropFilter: "blur(12px)",
            borderRadius: 18,
            boxShadow: "0 4px 32px 0 rgba(34,211,238,0.10)",
            padding: 24,
            border: "1.5px solid rgba(63,63,70,0.32)",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 14, fontSize: 20, color: "#22d3ee" }}>Session</div>
          <div style={{ fontSize: 14, color: "#a1a1aa" }}>Username</div>
          <input
            style={{
              width: "100%",
              padding: 12,
              marginTop: 8,
              borderRadius: 12,
              border: "1.5px solid #22d3ee",
              background: "#23272f",
              color: "#22d3ee",
              fontWeight: 600,
              fontSize: 16,
              outline: "none",
              marginBottom: 12,
              transition: "border 0.2s",
            }}
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder="your name"
          />
          <div style={{ fontSize: 14, color: "#a1a1aa" }}>Peer</div>
          <input
            style={{
              width: "100%",
              padding: 12,
              marginTop: 8,
              borderRadius: 12,
              border: "1.5px solid #818cf8",
              background: "#23272f",
              color: "#818cf8",
              fontWeight: 600,
              fontSize: 16,
              outline: "none",
              marginBottom: 16,
              transition: "border 0.2s",
            }}
            value={peer}
            onChange={e => setPeer(e.target.value)}
            placeholder="peer username"
          />
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <button
              onClick={handleRegister}
              disabled={!username || !localPubB64Ref.current}
              style={{
                padding: "10px 18px",
                borderRadius: 12,
                background: "linear-gradient(90deg, #22d3ee 60%, #818cf8 100%)",
                border: "none",
                color: "#fff",
                fontWeight: 700,
                fontSize: 15,
                cursor: "pointer",
                boxShadow: "0 2px 8px 0 rgba(34,211,238,0.10)",
                letterSpacing: 1,
                transition: "background 0.2s",
              }}
            >
              Register
            </button>
            <button
              onClick={establishSharedKeyWithPeer}
              disabled={!peer || !localPubB64Ref.current}
              style={{
                padding: "10px 18px",
                borderRadius: 12,
                background: "linear-gradient(90deg, #818cf8 60%, #22d3ee 100%)",
                border: "none",
                color: "#fff",
                fontWeight: 700,
                fontSize: 15,
                cursor: "pointer",
                boxShadow: "0 2px 8px 0 rgba(129,140,248,0.10)",
                letterSpacing: 1,
                transition: "background 0.2s",
              }}
            >
              Establish Key
            </button>
          </div>

          <div style={{ height: 18 }} />
          <div style={{ fontSize: 14, color: "#a1a1aa", marginBottom: 8 }}>Selected object</div>
          <div
            style={{
              padding: 12,
              background: "rgba(34,211,238,0.10)",
              borderRadius: 12,
              color: "#22d3ee",
              fontWeight: 700,
              fontSize: 18,
              marginBottom: 8,
              boxShadow: "0 2px 8px 0 rgba(34,211,238,0.08)",
            }}
          >
            {selected || "None"}
            <div style={{ fontSize: 12, color: "#818cf8", marginTop: 4, fontWeight: 500 }}>
              {detections.length} objects in view
            </div>
          </div>

          <div style={{ height: 16 }} />
          <div style={{ fontSize: 14, color: "#a1a1aa" }}>Encrypted Message</div>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Type message..."
            rows={5}
            style={{
              width: "100%",
              marginTop: 10,
              borderRadius: 12,
              background: "#23272f",
              color: "#818cf8",
              border: "1.5px solid #818cf8",
              padding: 12,
              fontSize: 15,
              fontWeight: 500,
              outline: "none",
              marginBottom: 10,
              resize: "vertical",
            }}
          />
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <button
              onClick={sendMessage}
              style={{
                padding: "10px 18px",
                borderRadius: 12,
                background: "linear-gradient(90deg, #22d3ee 60%, #818cf8 100%)",
                border: "none",
                color: "#fff",
                fontWeight: 700,
                fontSize: 15,
                cursor: "pointer",
                boxShadow: "0 2px 8px 0 rgba(34,211,238,0.10)",
                letterSpacing: 1,
                transition: "background 0.2s",
              }}
            >
              Send
            </button>
            <button
              onClick={() => setInput("")}
              style={{
                padding: "10px 18px",
                borderRadius: 12,
                background: "linear-gradient(90deg, #818cf8 60%, #22d3ee 100%)",
                border: "none",
                color: "#fff",
                fontWeight: 700,
                fontSize: 15,
                cursor: "pointer",
                boxShadow: "0 2px 8px 0 rgba(129,140,248,0.10)",
                letterSpacing: 1,
                transition: "background 0.2s",
              }}
            >
              Clear
            </button>
          </div>

          <div style={{ height: 18 }} />
          <div style={{ fontSize: 14, color: "#a1a1aa" }}>Known peer public keys</div>
          <div
            style={{
              marginTop: 10,
              maxHeight: 160,
              overflowY: "auto",
              background: "#23272f",
              padding: 10,
              borderRadius: 12,
              fontSize: 13,
              color: "#f4f4f5",
              boxShadow: "0 2px 8px 0 rgba(34,211,238,0.08)",
            }}
          >
            {Object.keys(peerPubMap).length === 0 && (
              <div style={{ color: "#818cf8" }}>No peer public keys yet</div>
            )}
            {Object.entries(peerPubMap).map(([u, k]) => (
              <div key={u} style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 700, color: "#818cf8" }}>{u}</div>
                <div style={{ fontSize: 12, color: "#a1a1aa", wordBreak: "break-all" }}>
                  {k.slice(0, 60)}
                  {k.length > 60 ? "..." : ""}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Video */}
        <div
          style={{
            background: "rgba(36,37,46,0.98)",
            backdropFilter: "blur(12px)",
            borderRadius: 18,
            boxShadow: "0 4px 32px 0 rgba(34,211,238,0.10)",
            padding: 24,
            border: "1.5px solid rgba(63,63,70,0.32)",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 14, fontSize: 20, color: "#22d3ee" }}>Live Camera</div>
          <div
            style={{
              width: "100%",
              position: "relative",
              background: "#18181b",
              borderRadius: 14,
              overflow: "hidden",
              boxShadow: "0 2px 16px 0 rgba(34,211,238,0.10)",
            }}
          >
            <video
              ref={videoRef}
              onClick={handleVideoClick}
              style={{
                width: "100%",
                height: 480,
                objectFit: "cover",
                borderRadius: 14,
                filter: "brightness(1.08) saturate(1.1)",
              }}
              autoPlay
              muted
            />
            <canvas
              ref={overlayRef}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                pointerEvents: "none",
                zIndex: 2,
              }}
            />
          </div>
          <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
            <div style={{ fontSize: 15, color: "#a1a1aa", fontWeight: 500 }}>
              Tip: click a bounding box to select object
            </div>
          </div>
        </div>

        {/* Chat Sidebar */}
        <div
          style={{
            background: "rgba(36,37,46,0.98)",
            backdropFilter: "blur(12px)",
            borderRadius: 18,
            boxShadow: "0 4px 32px 0 rgba(129,140,248,0.10)",
            padding: 24,
            border: "1.5px solid rgba(63,63,70,0.32)",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 14, fontSize: 20, color: "#818cf8" }}>Object Chat</div>
          <div style={{ fontSize: 15, color: "#a1a1aa", marginBottom: 10, fontWeight: 500 }}>
            Messages for selected object
          </div>
          <div style={{ maxHeight: 480, overflowY: "auto", paddingRight: 8 }}>
            {selected && chats[selected] ? (
              chats[selected].map((m, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    flexDirection: m.sender === username ? "row-reverse" : "row",
                    marginBottom: 14,
                  }}
                >
                  <div
                    style={{
                      maxWidth: "80%",
                      background:
                        m.sender === username
                          ? "linear-gradient(90deg, #22d3ee 60%, #818cf8 100%)"
                          : "#23272f",
                      color: m.sender === username ? "#fff" : "#818cf8",
                      padding: 14,
                      borderRadius: 16,
                      fontWeight: 600,
                      fontSize: 15,
                      boxShadow: m.sender === username
                        ? "0 2px 8px 0 rgba(34,211,238,0.10)"
                        : "0 2px 8px 0 rgba(129,140,248,0.10)",
                    }}
                  >
                    <div style={{ fontSize: 15, fontWeight: 700 }}>
                      {m.plaintext || "[encrypted]"}
                    </div>
                    <div style={{ fontSize: 11, color: "#a1a1aa", marginTop: 8 }}>
                      {m.sender} • {new Date(m.ts || Date.now()).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div style={{ color: "#818cf8" }}>Select an object to see messages</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
