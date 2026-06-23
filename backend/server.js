const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- DATABASE SETUP ---
const MONGO_URI = process.env.MONGO_URI; 
if (!MONGO_URI) {
    console.warn("⚠️ WARNING: MONGO_URI not provided. Please add it to your Render Environment Variables.");
} else {
    mongoose.connect(MONGO_URI)
        .then(() => console.log('✅ Connected to MongoDB Atlas'))
        .catch(err => console.error('❌ MongoDB Error:', err));
}

// Database Schemas
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, maxLength: 20 },
  password: { type: String, required: true }
});
const User = mongoose.model('User', UserSchema);

const MessageSchema = new mongoose.Schema({
  username: String,
  text: String,
  timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

// --- REAL-TIME LOGIC ---
const onlineUsers = new Map(); // Tracks socket.id -> username

function broadcastOnlineUsers() {
  const users = Array.from(new Set(onlineUsers.values()));
  io.emit('online_users', users);
}

io.on('connection', (socket) => {
  
  // 1. Handle Registration
  socket.on('register', async (data, callback) => {
    try {
      if (!MONGO_URI) return callback({ error: 'Database not connected on server.' });
      if (!data.username || !data.password) return callback({ error: 'Missing fields.' });
      
      const cleanUser = data.username.trim().substring(0, 20);
      if (cleanUser.length < 3) return callback({ error: 'Username must be at least 3 characters.' });

      // Check if username exists (Case Insensitive)
      const existing = await User.findOne({ username: { $regex: new RegExp(`^${cleanUser}$`, 'i') } }); 
      if (existing) return callback({ error: 'Username is taken.' });

      // Encrypt the password before saving it to the database
      const hashedPassword = await bcrypt.hash(data.password, 10);
      await User.create({ username: cleanUser, password: hashedPassword });
      callback({ success: true });
    } catch (err) {
      callback({ error: 'Registration failed.' });
    }
  });

  // 2. Handle Login
  socket.on('login', async (data, callback) => {
    try {
      if (!MONGO_URI) return callback({ error: 'Database not connected on server.' });
      if (!data.username || !data.password) return callback({ error: 'Missing fields.' });
      
      const cleanUser = data.username.trim();
      const user = await User.findOne({ username: { $regex: new RegExp(`^${cleanUser}$`, 'i') } });
      if (!user) return callback({ error: 'User not found.' });

      // Check if password matches the hash
      const isMatch = await bcrypt.compare(data.password, user.password);
      if (!isMatch) return callback({ error: 'Incorrect password.' });

      socket.username = user.username;
      onlineUsers.set(socket.id, user.username);
      broadcastOnlineUsers();
      socket.broadcast.emit('system_message', `${user.username} joined the chat.`);

      // Send the last 100 messages for Chat History
      const history = await Message.find().sort({ timestamp: -1 }).limit(100);
      callback({ success: true, username: user.username, history: history.reverse() });
    } catch (err) {
      callback({ error: 'Login failed.' });
    }
  });

  // 3. Handle Messages
  socket.on('chat_message', async (text) => {
    if (!socket.username || typeof text !== 'string') return;
    const cleanText = text.trim().substring(0, 1000); // Max message size
    if (!cleanText) return;

    try {
      if (MONGO_URI) {
          const msg = await Message.create({ username: socket.username, text: cleanText });
          io.emit('chat_message', { id: socket.id, username: msg.username, text: msg.text, timestamp: msg.timestamp });
      }
    } catch (err) {
      console.error("Message save error", err);
    }
  });

  // 4. Handle Typing Indicators
  socket.on('typing', (isTyping) => {
    if (socket.username) {
      socket.broadcast.emit('typing', { username: socket.username, isTyping });
    }
  });

  // 5. Handle Disconnects
  socket.on('disconnect', () => {
    if (socket.username) {
      onlineUsers.delete(socket.id);
      broadcastOnlineUsers();
      io.emit('system_message', `${socket.username} left the chat.`);
    }
  });
});

app.get('/', (req, res) => res.send('Chat Pro Backend Running!'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));