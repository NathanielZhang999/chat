const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors()); // Allow requests from any frontend

const server = http.createServer(app);

// Initialize Socket.io with permissive CORS so local HTML files aren't blocked
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Listen for a message from a user
  socket.on('chat_message', (data) => {
    // Basic validation to prevent server crashes
    if (!data || typeof data.username !== 'string' || typeof data.text !== 'string') return;

    // Broadcast the message to EVERYONE (including the sender)
    io.emit('chat_message', {
      id: socket.id,
      username: data.username.substring(0, 30), // Prevent massive names
      text: data.text.substring(0, 2000),       // Prevent text wall spam
      timestamp: Date.now()
    });
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

// A simple HTTP route for Render's health checks
app.get('/', (req, res) => res.send('Chat Backend is Running!'));

// Use the dynamic port Render assigns
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});