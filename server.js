const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ensure uploads directory exists
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `${Date.now()}-${safeName}`;
    cb(null, filename);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

app.use(express.static("public"));
// serve uploaded files
app.use("/uploads", express.static(uploadsDir));

// simple upload endpoint used by client for files and voice messages
app.post("/upload", upload.single("file"), (req, res) => {
  try {
    const file = req.file;
    const { senderId, recipientId, username, type } = req.body;

    if (!file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    const fileUrl = `/uploads/${file.filename}`;
    const payload = {
      username: username || (senderId && users[senderId] ? users[senderId] : "Anonymous") || "Anonymous",
      message: fileUrl,
      type: type || "file",
      originalName: file.originalname,
      senderId,
      recipientId: recipientId || null,
      timestamp: Date.now(),
    };

    // if recipientId provided and that socket exists -> private
    if (recipientId && io.sockets.sockets.get(recipientId)) {
      io.to(recipientId).emit("chat message", payload);
      if (senderId) io.to(senderId).emit("chat message", payload); // show back to sender
    } else {
      // global
      io.emit("chat message", payload);
    }

    return res.json({ ok: true, fileUrl });
  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ error: "Upload failed." });
  }
});

const users = {}; // socket.id -> username

io.on("connection", (socket) => {
  console.log("🟢 New user connected:", socket.id);

  // Send the connecting client their socket id (helpful)
  socket.emit("your id", socket.id);

  // Receive username from client
  socket.on("set username", (username) => {
    const assigned = username && username.trim() ? username.trim() : "Anonymous";
    users[socket.id] = assigned;

    // send updated user list to everyone
    io.emit(
      "user list",
      Object.entries(users).map(([id, name]) => ({ id, name }))
    );

    // notify others that a user joined
    socket.broadcast.emit("user notification", `${assigned} joined the chat`);
  });

  // Receive chat messages (either text or objects with recipient)
  socket.on("chat message", (data) => {
    const username = users[socket.id] || "Anonymous";

    // If client sent just a string, treat as global text
    if (typeof data === "string") {
      io.emit("chat message", {
        username,
        message: data,
        type: "text",
        senderId: socket.id,
        recipientId: null,
        timestamp: Date.now(),
      });
      return;
    }

    // data is object: { message, recipientId }
    const message = data.message;
    const recipientId = data.recipientId || null;

    const payload = {
      username,
      message,
      type: data.type || "text",
      senderId: socket.id,
      recipientId,
      timestamp: Date.now(),
    };

    if (recipientId && io.sockets.sockets.get(recipientId)) {
      // private: send to recipient and the sender
      io.to(recipientId).emit("chat message", payload);
      socket.emit("chat message", payload);
    } else {
      // global broadcast
      io.emit("chat message", payload);
    }
  });

  socket.on("disconnect", () => {
    const username = users[socket.id];
    delete users[socket.id];
    io.emit(
      "user list",
      Object.entries(users).map(([id, name]) => ({ id, name }))
    );
    if (username) {
      io.emit("user notification", `${username} left the chat`);
    }
    console.log("🔴 User disconnected:", socket.id);
  });
});

// start server
const PORT = process.env.PORT || 4000;

// handle listen errors gracefully (EADDRINUSE etc.)
server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`ERROR: Port ${PORT} is already in use. Stop the process using that port or set PORT to a different value.`);
    process.exit(1);
  }
  console.error("Server error:", err);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});