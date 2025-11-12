const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

console.log('🚀 Iniciando servidor de videochat...');

const app = express();
const server = http.createServer(app);

// Configuración CORS MEJORADA - MÁS FLEXIBLE
app.use(cors({
  origin: function (origin, callback) {
    // Permitir solicitudes sin origen (como apps móviles o Postman)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      "https://thinkenlac.es",
      "https://www.thinkenlac.es",
      "https://thinkandcreateservices.com", 
      "https://www.thinkandcreateservices.com",
      "http://localhost:3000",
      "http://localhost:8080",
      "http://192.168.1.1:8080",
      "http://192.168.1.2:8080",
      "http://192.168.1.3:8080",
      "http://192.168.0.1:8080",
      "http://192.168.0.2:8080"
    ];
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      // También permitir cualquier subdominio de thinkenlac.es y thinkandcreateservices.com
      if (origin.endsWith('.thinkenlac.es') || origin.endsWith('.thinkandcreateservices.com')) {
        callback(null, true);
      } else {
        console.log('🔒 Origen CORS bloqueado:', origin);
        callback(new Error('Not allowed by CORS'));
      }
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
}));

// Middleware para manejar preflight requests
app.options('*', cors());

// Configuración de Socket.IO MEJORADA
const io = socketIo(server, {
  cors: {
    origin: function (origin, callback) {
      // Permitir solicitudes sin origen
      if (!origin) return callback(null, true);
      
      const allowedOrigins = [
        "https://thinkenlac.es",
        "https://www.thinkenlac.es", 
        "https://thinkandcreateservices.com",
        "https://www.thinkandcreateservices.com",
        "http://localhost:3000",
        "http://localhost:8080",
        "http://192.168.1.1:8080",
        "http://192.168.1.2:8080"
      ];
      
      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else if (origin.endsWith('.thinkenlac.es') || origin.endsWith('.thinkandcreateservices.com')) {
        callback(null, true);
      } else {
        console.log('🔒 Origen Socket.IO bloqueado:', origin);
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"]
  },
  maxHttpBufferSize: 1e7,
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  transports: ['websocket', 'polling']
});

// Almacenamiento en memoria
const rooms = new Map();
const users = new Map();
const sharedFiles = new Map();
const chatMessages = new Map();

// TEMPORIZADOR GLOBAL
let globalTimer = null;

function startGlobalTimer() {
    if (globalTimer) return;

    globalTimer = setInterval(() => {
        let hasActiveRooms = false;

        for (const [roomId, room] of rooms) {
            if (room.timer > 0) {
                room.timer--;
                hasActiveRooms = true;

                io.to(roomId).emit('timer-update', {
                    timeRemaining: room.timer
                });

                if (room.timer <= 0) {
                    io.to(roomId).emit('room-time-ended');
                    console.log(`🕒 Tiempo agotado para sala: ${roomId}`);

                    // Limpiar sala cuando el tiempo termina
                    room.users.forEach(userId => {
                        const userSocket = io.sockets.sockets.get(userId);
                        if (userSocket) {
                            userSocket.leave(roomId);
                        }
                    });
                    rooms.delete(roomId);
                    chatMessages.delete(roomId);
                }
            }
        }

        if (!hasActiveRooms) {
            clearInterval(globalTimer);
            globalTimer = null;
            console.log('⏰ Temporizador global detenido (no hay salas activas)');
        }
    }, 1000);
}

// Función para actualizar lista de usuarios
function updateUsersList(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const usersList = room.users.map(userId => {
    const user = users.get(userId);
    return user ? {
      id: user.id,
      name: user.name,
      isCreator: user.isCreator,
      handRaised: user.handRaised,
      audioEnabled: user.audioEnabled
    } : null;
  }).filter(Boolean);

  io.to(roomId).emit('users-list-updated', usersList);
}

// Función para obtener historial del chat
function getChatHistory(roomId) {
  if (!chatMessages.has(roomId)) {
    chatMessages.set(roomId, []);
  }
  return chatMessages.get(roomId);
}

// Función para agregar mensaje al chat
function addChatMessage(roomId, messageData) {
  const history = getChatHistory(roomId);
  history.push(messageData);
  
  // Mantener solo los últimos 100 mensajes por sala
  if (history.length > 100) {
    history.shift();
  }
}

// Manejo de conexiones Socket.IO
io.on('connection', (socket) => {
  console.log('🔌 Nuevo usuario conectado:', socket.id);
  
  // Registrar usuario
  users.set(socket.id, {
    id: socket.id,
    name: `Usuario ${socket.id.substr(0, 6)}`,
    roomId: null,
    isCreator: false,
    handRaised: false,
    audioEnabled: true
  });

  socket.on('ping', (data) => {
    // Simplemente responder con pong para mantener la conexión activa
    socket.emit('pong', { 
        timestamp: data.timestamp,
        serverTime: Date.now() 
    });
  });

  // Configurar transporte para móviles
  socket.conn.on("upgrade", (transport) => {
    console.log(`🔄 Usuario ${socket.id} actualizado a: ${transport.name}`);
  });

  // Manejar errores de conexión
  socket.conn.on("error", (error) => {
    console.error(`❌ Error de conexión para ${socket.id}:`, error);
  });

  // Crear sala
  socket.on('create-room', (data) => {
    console.log('🎪 Creando sala:', data.roomId);
    
    const roomId = data.roomId || 'room-' + Math.random().toString(36).substr(2, 9);
    const duration = data.duration || 60;

    if (!globalTimer) {
        startGlobalTimer();
    }

    rooms.set(roomId, {
        id: roomId,
        creator: socket.id,
        users: [socket.id],
        createdAt: Date.now(),
        duration: duration,
        timer: duration * 60
    });

    // Inicializar historial de chat para la sala
    chatMessages.set(roomId, []);

    socket.join(roomId);
    socket.roomId = roomId;

    const user = users.get(socket.id);
    user.roomId = roomId;
    user.name = data.username || user.name;
    user.isCreator = true;

    socket.emit('room-created', {
        roomId: roomId,
        duration: duration
    });

    socket.emit('timer-update', {
        timeRemaining: duration * 60
    });

    updateUsersList(roomId);
    console.log(`✅ Sala creada: ${roomId} por ${socket.id} - Duración: ${duration}min`);
  });

  // Unirse a sala
  socket.on('join-room', (data) => {
    console.log('🚪 Uniéndose a sala:', data.roomId);
    const roomId = data.roomId;
    const room = rooms.get(roomId);

    if (!room) {
        socket.emit('room-not-found');
        return;
    }

    if (room.users.length >= 10) {
        socket.emit('room-full');
        return;
    }

    socket.join(roomId);
    socket.roomId = roomId;
    room.users.push(socket.id);

    const user = users.get(socket.id);
    user.roomId = roomId;
    user.name = data.username || user.name;
    user.isCreator = false;

    setTimeout(() => {
        socket.to(roomId).emit('user-joined', {
            userId: socket.id,
            username: user.name
        });
    }, 100);

    const existingUsers = room.users.filter(id => id !== socket.id).map(id => {
        const u = users.get(id);
        return u ? {
            id: u.id,
            name: u.name,
            isCreator: u.isCreator,
            handRaised: u.handRaised,
            audioEnabled: u.audioEnabled
        } : null;
    }).filter(Boolean);

    // Enviar historial del chat al usuario que se une
    const chatHistory = getChatHistory(roomId);
    
    socket.emit('room-joined', {
        roomId: roomId,
        existingUsers: existingUsers,
        duration: room.duration,
        timeRemaining: room.timer,
        chatHistory: chatHistory
    });

    updateUsersList(roomId);
    console.log(`✅ Usuario ${socket.id} se unió a ${roomId}`);
  });

  // Reunirse a sala (para reconexiones)
  socket.on('rejoin-room', (data) => {
    console.log('🔄 Reunirse a sala:', data.roomId);
    const roomId = data.roomId;
    const room = rooms.get(roomId);

    if (!room) {
        socket.emit('room-not-found');
        return;
    }

    if (!room.users.includes(socket.id)) {
        room.users.push(socket.id);
    }

    socket.join(roomId);
    socket.roomId = roomId;

    const user = users.get(socket.id);
    user.roomId = roomId;
    user.name = data.username || user.name;

    const existingUsers = room.users.filter(id => id !== socket.id).map(id => {
        const u = users.get(id);
        return u ? {
            id: u.id,
            name: u.name,
            isCreator: u.isCreator,
            handRaised: u.handRaised,
            audioEnabled: u.audioEnabled
        } : null;
    }).filter(Boolean);

    // Enviar historial del chat en reconexión
    const chatHistory = getChatHistory(roomId);

    socket.emit('rejoin-success', {
        roomId: roomId,
        existingUsers: existingUsers,
        chatHistory: chatHistory
    });

    updateUsersList(roomId);
    console.log(`✅ Usuario ${socket.id} se reconectó a ${roomId}`);
  });

  // Señales WebRTC
  socket.on('webrtc-signal', (data) => {
    if (data.target && data.roomId) {
      console.log(`📨 Reenviando señal WebRTC de ${socket.id} a ${data.target}`);
      socket.to(data.target).emit('webrtc-signal', {
        ...data,
        sender: socket.id
      });
    }
  });

  // Manejo de mensajes de chat
  socket.on('chat-message', (data) => {
    const user = users.get(socket.id);
    if (user && user.roomId) {
      const messageData = {
        id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
        userId: socket.id,
        userName: user.name,
        message: data.message,
        timestamp: new Date().toISOString(),
        type: 'text'
      };

      // Guardar mensaje en el historial
      addChatMessage(user.roomId, messageData);

      // Enviar a todos en la sala
      io.to(user.roomId).emit('chat-message', messageData);
      
      console.log(`💬 Chat [${user.roomId}]: ${user.name}: ${data.message}`);
    }
  });

  // Mensajes del sistema
  socket.on('system-message', (data) => {
    if (data.roomId) {
      const messageData = {
        id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
        userId: 'system',
        userName: 'Sistema',
        message: data.message,
        timestamp: new Date().toISOString(),
        type: 'system'
      };

      addChatMessage(data.roomId, messageData);
      io.to(data.roomId).emit('chat-message', messageData);
      
      console.log(`🔔 Sistema [${data.roomId}]: ${data.message}`);
    }
  });

  // Resto de los eventos existentes...
  socket.on('update-username', (data) => {
    const user = users.get(socket.id);
    if (user) {
      const oldName = user.name;
      user.name = data.newUsername;

      if (user.roomId) {
        socket.to(user.roomId).emit('username-updated', {
          userId: socket.id,
          newUsername: data.newUsername,
          oldUsername: oldName
        });
        updateUsersList(user.roomId);
      }
      console.log(`📝 Usuario ${socket.id} cambió nombre a: ${data.newUsername}`);
    }
  });

  socket.on('screen-share-status', (data) => {
    if (data.roomId && data.userId) {
      socket.to(data.roomId).emit('screen-share-status', {
        userId: data.userId,
        isSharing: data.isSharing
      });
    }
  });

  socket.on('toggle-hand', (data) => {
    const user = users.get(socket.id);
    if (user && user.roomId) {
      user.handRaised = data.handRaised;
      socket.to(user.roomId).emit('user-hand-toggled', {
        userId: socket.id,
        handRaised: data.handRaised,
        userName: user.name
      });
      updateUsersList(user.roomId);
    }
  });

  socket.on('file-upload-start', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('file-upload-started', {
        userId: data.userId,
        fileName: data.fileName,
        fileSize: data.fileSize
      });
    }
  });

  socket.on('file-upload-progress', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('file-upload-progress', {
        userId: data.userId,
        fileName: data.fileName,
        progress: data.progress
      });
    }
  });

  socket.on('file-upload', (data) => {
    const fileId = Math.random().toString(36).substr(2, 9) + Date.now().toString(36);

    sharedFiles.set(fileId, {
      fileId: fileId,
      fileName: data.fileName,
      fileSize: data.fileSize,
      fileType: data.fileType,
      fileData: data.fileData,
      userId: data.userId,
      userName: data.userName,
      timestamp: Date.now()
    });

    if (data.roomId) {
      io.to(data.roomId).emit('file-upload-completed', {
        fileId: fileId,
        fileName: data.fileName,
        fileSize: data.fileSize,
        fileType: data.fileType,
        userId: data.userId,
        userName: data.userName,
        timestamp: Date.now()
      });
    }
  });

  socket.on('file-download-request', (data) => {
    const fileData = sharedFiles.get(data.fileId);
    if (fileData) {
      socket.emit('file-download-response', fileData);
    }
  });

  socket.on('leave-room', (data) => {
    const roomId = data.roomId || socket.roomId;
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        room.users = room.users.filter(id => id !== socket.id);
        socket.to(roomId).emit('user-left', { userId: socket.id });

        if (room.users.length === 0) {
          rooms.delete(roomId);
          chatMessages.delete(roomId);
        } else {
          updateUsersList(roomId);
        }
      }
      socket.leave(roomId);
      socket.roomId = null;

      const user = users.get(socket.id);
      if (user) {
        user.roomId = null;
        user.handRaised = false;
        user.isCreator = false;
      }
      console.log(`🚪 Usuario ${socket.id} salió de ${roomId}`);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('❌ Usuario desconectado:', socket.id, 'Razón:', reason);

    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        room.users = room.users.filter(id => id !== socket.id);
        socket.to(socket.roomId).emit('user-left', { userId: socket.id });

        if (room.users.length === 0) {
          rooms.delete(socket.roomId);
          chatMessages.delete(socket.roomId);
        } else {
          updateUsersList(socket.roomId);
        }
      }
    }

    users.delete(socket.id);
  });
});

// Endpoint de salud para monitoreo
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    rooms: rooms.size,
    users: users.size,
    timestamp: new Date().toISOString()
  });
});

// Endpoint raíz
app.get('/', (req, res) => {
  res.json({ 
    message: 'VideoChat Backend está funcionando',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Middleware para manejar errores CORS
app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    res.status(403).json({ error: 'CORS no permitido para este origen' });
  } else {
    next(err);
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend de videochat ejecutándose en puerto ${PORT}`);
  console.log('📍 Listo para conexiones desde:');
  console.log('   - https://thinkenlac.es');
  console.log('   - https://www.thinkenlac.es');
  console.log('   - https://thinkandcreateservices.com');
  console.log('   - Dispositivos móviles');
  console.log('🔧 Configuración CORS activada');
});
