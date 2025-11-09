const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

console.log('🚀 Iniciando servidor de videochat...');

const app = express();
const server = http.createServer(app);

// Configuración CORS para permitir tus dominios
app.use(cors({
  origin: [
    "https://thinkenlac.es",
    "https://www.thinkenlac.es",
    "https://thinkandcreateservices.com",
    "https://www.thinkandcreateservices.com",
    "http://localhost:3000" // Para desarrollo local
  ],
  credentials: true
}));

// Configuración de Socket.IO
const io = socketIo(server, {
  cors: {
    origin: [
      "https://thinkenlac.es",
      "https://www.thinkenlac.es",
      "https://thinkandcreateservices.com",
      "https://www.thinkandcreateservices.com",
      "http://localhost:3000"
    ],
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1e7, // 10MB máximo para archivos
  pingTimeout: 60000,
  pingInterval: 25000
});

// Almacenamiento en memoria
const rooms = new Map();
const users = new Map();
const sharedFiles = new Map();

// TEMPORIZADOR GLOBAL - Agregar esto después de las declaraciones de Map
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

  // Crear sala
  socket.on('create-room', (data) => {
    console.log('🎪 Creando sala:', data.roomId);

    const roomId = data.roomId || 'room-' + Math.random().toString(36).substr(2, 9);
    const duration = data.duration || 60;

    rooms.set(roomId, {
      id: roomId,
      creator: socket.id,
      users: [socket.id],
      createdAt: Date.now(),
      duration: duration,
      timer: duration * 60
    });

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

    updateUsersList(roomId);
    console.log(`✅ Sala creada: ${roomId} por ${socket.id}`);
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

    socket.join(roomId);
    socket.roomId = roomId;
    room.users.push(socket.id);

    const user = users.get(socket.id);
    user.roomId = roomId;
    user.name = data.username || user.name;
    user.isCreator = false;

    // Notificar a otros usuarios
    socket.to(roomId).emit('user-joined', {
      userId: socket.id,
      username: user.name
    });

    // Enviar usuarios existentes al nuevo usuario
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

    socket.emit('room-joined', {
      roomId: roomId,
      existingUsers: existingUsers,
      duration: room.duration,
      timeRemaining: room.timer
    });

    updateUsersList(roomId);
    console.log(`✅ Usuario ${socket.id} se unió a ${roomId}`);
  });

  // Señalización WebRTC
  socket.on('webrtc-signal', (data) => {
    if (data.target && data.roomId) {
      const room = rooms.get(data.roomId);
      if (room && room.users.includes(data.target)) {
        socket.to(data.target).emit('webrtc-signal', {
          ...data,
          sender: socket.id
        });
      }
    }
  });

  // Actualizar nombre de usuario
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

  // Estado de pantalla compartida
  socket.on('screen-share-status', (data) => {
    if (data.roomId && data.userId) {
      socket.to(data.roomId).emit('screen-share-status', {
        userId: data.userId,
        isSharing: data.isSharing
      });
    }
  });

  // Mano levantada
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

  // Archivos - Inicio de subida
  socket.on('file-upload-start', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('file-upload-started', {
        userId: data.userId,
        fileName: data.fileName,
        fileSize: data.fileSize
      });
    }
  });

  // Archivos - Progreso
  socket.on('file-upload-progress', (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit('file-upload-progress', {
        userId: data.userId,
        fileName: data.fileName,
        progress: data.progress
      });
    }
  });

  // Archivos - Completado
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

  // Solicitud de descarga de archivo
  socket.on('file-download-request', (data) => {
    const fileData = sharedFiles.get(data.fileId);
    if (fileData) {
      socket.emit('file-download-response', fileData);
    }
  });

  // Abandonar sala
  socket.on('leave-room', (data) => {
    const roomId = data.roomId || socket.roomId;
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        room.users = room.users.filter(id => id !== socket.id);
        socket.to(roomId).emit('user-left', { userId: socket.id });

        if (room.users.length === 0) {
          rooms.delete(roomId);
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

  // Desconexión
  socket.on('disconnect', () => {
    console.log('❌ Usuario desconectado:', socket.id);

    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        room.users = room.users.filter(id => id !== socket.id);
        socket.to(socket.roomId).emit('user-left', { userId: socket.id });

        if (room.users.length === 0) {
          rooms.delete(socket.roomId);
        } else {
          updateUsersList(socket.roomId);
        }
      }
    }

    users.delete(socket.id);
  });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend de videochat ejecutándose en puerto ${PORT}`);
  console.log('📍 Listo para conexiones desde:');
  console.log('   - https://thinkenlac.es');
  console.log('   - https://thinkandcreateservices.com');
});
