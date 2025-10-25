// server.js
// Socket.IO relay with simple public-key forwarding for E2E key agreement
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.get("/", (req, res) => res.send("Socket.IO relay running"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// in-memory stores (demo)
const users = {};      // username -> socketId
const pubkeys = {};    // username -> base64 publicKey (ECDH raw)

io.on("connection", (socket) => {
  console.log("Client connected", socket.id);

  // register user (and optionally public key)
  socket.on("register", ({ username, publicKeyB64 }) => {
    if (!username) return;
    users[username] = socket.id;
    if (publicKeyB64) pubkeys[username] = publicKeyB64;
    console.log("Registered:", username, socket.id);
  });

  // save/refresh public key
  socket.on("save_pubkey", ({ username, publicKeyB64 }) => {
    if (!username || !publicKeyB64) return;
    pubkeys[username] = publicKeyB64;
    console.log("Saved pubkey for", username);
  });

  // requester asks server for peer's public key
  socket.on("get_pubkey", ({ requester, peer }) => {
    const peerPub = pubkeys[peer] || null;
    io.to(socket.id).emit("pubkey_response", { peer, publicKeyB64: peerPub });
  });

  // send your public key to a peer (server forwards)
  socket.on("send_pubkey_to", ({ from, to, publicKeyB64 }) => {
    const dest = users[to];
    if (dest) {
      io.to(dest).emit("peer_pubkey", { from, publicKeyB64 });
    }
  });

  // message relay (message contains encrypted payload)
  socket.on("message", (msg) => {
    // msg: { sender, receiver, object_id, text_enc: {ciphertext, iv}, ts }
    if (!msg || !msg.receiver) return;
    const dest = users[msg.receiver];
    // deliver to receiver if online
    if (dest) io.to(dest).emit("message", msg);
    // echo back to sender (confirm)
    io.to(socket.id).emit("message", msg);
  });

  socket.on("disconnect", () => {
    console.log("Disconnect", socket.id);
    // remove user mapping if exists
    for (const [u, sid] of Object.entries(users)) {
      if (sid === socket.id) {
        delete users[u];
        delete pubkeys[u];
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Socket.IO server listening on http://localhost:${PORT}`));
