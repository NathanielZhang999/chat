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

// Database Schemas
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, maxLength: 20 },
  password: { type: String, required: true },
  role: { type: String, default: 'user' } // NEW: Tracks 'user' vs 'admin'
});
const User = mongoose.model('User', UserSchema);

const MessageSchema = new mongoose.Schema({
  username: String,
  text: String,
  edited: { type: Boolean, default: false }, // NEW: Tracks if a message was edited
  timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

// AUTO-CREATE THE ADMIN ON SERVER START
async function seedAdmin() {
  try {
    const adminUser = 'NYZhang1';
    const adminPass = 'DragonNYZ0924';
    
    const hashed = await bcrypt.hash(adminPass, 10);
    // This safely creates the admin if it doesn't exist, or updates it if it does
    await User.findOneAndUpdate(
      { username: { $regex: new RegExp(`^${adminUser}$`, 'i') } },
      { username: adminUser, password: hashed, role: 'admin' },
      { upsert: true, new: true }
    );
    console.log('👑 Admin account (NYZhang1) is locked and loaded.');
  } catch (err) {
    console.error("Admin setup error:", err);
  }
}

if (!MONGO_URI) {
    console.warn("⚠️ WARNING: MONGO_URI not provided.");
} else {
    mongoose.connect(MONGO_URI)
        .then(() => {
            console.log('✅ Connected to MongoDB Atlas');
            seedAdmin(); // Run the script
        })
        .catch(err => console.error('❌ MongoDB Error:', err));
}

// --- REAL-TIME LOGIC ---
const onlineUsers = new Map();

function broadcastOnlineUsers() {
  const users = Array.from(new Set(onlineUsers.values()));
  io.emit('online_users', users);
}

io.on('connection', (socket) => {
  
  socket.on('register', async (data, callback) => {
    try {
      if (!MONGO_URI) return callback({ error: 'Database not connected.' });
      if (!data.username || !data.password) return callback({ error: 'Missing fields.' });
      
      const cleanUser = data.username.trim().substring(0, 20);
      if (cleanUser.length < 3) return callback({ error: 'Username must be at least 3 characters.' });
      
      // Stop people from trying to manually register the admin name
      if (cleanUser.toLowerCase() === 'nyzhang1') return callback({ error: 'This name is reserved.' });

      const existing = await User.findOne({ username: { $regex: new RegExp(`^${cleanUser}$`, 'i') } }); 
      if (existing) return callback({ error: 'Username is taken.' });

      const hashedPassword = await bcrypt.hash(data.password, 10);
      await User.create({ username: cleanUser, password: hashedPassword });
      callback({ success: true });
    } catch (err) {
      callback({ error: 'Registration failed.' });
    }
  });

  socket.on('login', async (data, callback) => {
    try {
      const cleanUser = data.username.trim();
      const user = await User.findOne({ username: { $regex: new RegExp(`^${cleanUser}$`, 'i') } });
      if (!user) return callback({ error: 'User not found.' });

      const isMatch = await bcrypt.compare(data.password, user.password);
      if (!isMatch) return callback({ error: 'Incorrect password.' });

      // Save user details AND role to their active session
      socket.username = user.username;
      socket.role = user.role; 
      
      onlineUsers.set(socket.id, user.username);
      broadcastOnlineUsers();
      socket.broadcast.emit('system_message', `${user.username} joined the chat.`);

      const history = await Message.find().sort({ timestamp: -1 }).limit(100);
      // Return their role to the frontend so it knows whether to show admin buttons
      callback({ success: true, username: user.username, role: user.role, history: history.reverse() });
    } catch (err) {
      callback({ error: 'Login failed.' });
    }
  });

  socket.on('chat_message', async (text) => {
    if (!socket.username || typeof text !== 'string') return;
    const cleanText = text.trim().substring(0, 1000);
    if (!cleanText) return;

    try {
      const msg = await Message.create({ username: socket.username, text: cleanText });
      // Send the Database ID (_id) to the frontend so we can target it for edits/deletes
      io.emit('chat_message', { _id: msg._id, username: msg.username, text: msg.text, timestamp: msg.timestamp, edited: false });
    } catch (err) {}
  });

  // --- NEW: EDIT AND DELETE LOGIC ---
  socket.on('delete_message', async (msgId) => {
    if (!socket.username || !msgId) return;
    try {
      const msg = await Message.findById(msgId);
      // Security Check: Is it their message? Or are they the Admin?
      if (msg && (msg.username === socket.username || socket.role === 'admin')) {
        await Message.findByIdAndDelete(msgId);
        io.emit('message_deleted', msgId); // Tell all frontends to wipe it
      }
    } catch (err) {}
  });

  socket.on('edit_message', async (data) => {
    if (!socket.username || !data.id || typeof data.text !== 'string') return;
    const cleanText = data.text.trim().substring(0, 1000);
    if (!cleanText) return;

    try {
      const msg = await Message.findById(data.id);
      // Security Check: Is it their message? Or are they the Admin?
      if (msg && (msg.username === socket.username || socket.role === 'admin')) {
        msg.text = cleanText;
        msg.edited = true;
        await msg.save();
        io.emit('message_edited', { id: msg._id, text: cleanText }); // Tell all frontends to update text
      }
    } catch (err) {}
  });

  socket.on('typing', (isTyping) => {
    if (socket.username) socket.broadcast.emit('typing', { username: socket.username, isTyping });
  });

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