const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Socket.ioのセットアップ (CORS設定を含む)
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 静的ファイルの配信
app.use(express.static(path.join(__dirname, 'public')));

// ルーム管理
const rooms = new Map();

// Socket.io接続処理
io.on('connection', (socket) => {
    const clientIP = socket.handshake.address;
    console.log(`🔌 クライアント接続: ${socket.id} (IP: ${clientIP})`);

    // デバッグ: 全イベント受信ログ
    socket.onAny((eventName, ...args) => {
        console.log(`[${socket.id}] イベント受信: ${eventName}`, args);
    });

    // 初期状態
    socket.roomId = null;
    socket.isHost = false;

    // ルーム作成
    socket.on('createRoom', (data) => {
        const hostName = data.hostName;
        createRoom(socket, hostName);
    });

    // ルーム参加
    socket.on('joinRoom', (data) => {
        const { roomId, clientName } = data;
        joinRoom(socket, roomId, clientName);
    });

    // 利用可能なルーム一覧取得
    socket.on('getAvailableRooms', () => {
        sendAvailableRooms(socket);
    });

    // 時刻同期 Ping
    socket.on('syncPing', (data) => {
        socket.emit('syncPong', {
            clientTime: data.clientTime,
            serverTime: Date.now()
        });
    });

    // 設定更新 (BPMなど) - 全員が同じ瞬間に切り替えるため、適用時刻を付与
    socket.on('updateSettings', (data) => {
        if (socket.roomId) {
            const applyAt = Date.now() + 200; // 200ms後に全員同時適用
            // ホスト自身にも同じタイミングで適用させる
            io.in(socket.roomId).emit('settingsUpdated', {
                settings: data.settings,
                applyAt: applyAt
            });
        }
    });

    // メトロノーム開始
    socket.on('start', (data) => {
        if (socket.roomId && socket.isHost) {
            const startTime = Date.now() + 500; // 500ms後に開始
            // ルーム内の全員にブロードキャスト (自分含む)
            io.in(socket.roomId).emit('start', {
                settings: data.settings,
                startTime: startTime,
                includeCountIn: data.includeCountIn
            });
        }
    });

    // メトロノーム停止
    socket.on('stop', () => {
        if (socket.roomId && socket.isHost) {
            io.in(socket.roomId).emit('stop');
        }
    });

    // 切断時の処理
    socket.on('disconnect', () => {
        console.log(`クライアント切断: ${socket.id}`);
        handleDisconnect(socket);
    });
});

// --- ヘルパー関数 ---

function createRoom(socket, hostName) {
    const roomId = generateRoomId();
    rooms.set(roomId, {
        id: roomId,
        hostName: hostName || 'ホスト',
        host: socket,
        clients: new Set([socket]),
        settings: { bpm: 120, beatsPerBar: 4, beatUnit: 4 }
    });

    socket.roomId = roomId;
    socket.isHost = true;
    socket.displayName = hostName || 'ホスト';

    socket.join(roomId); // Socket.ioのルーム機能を使用

    socket.emit('roomCreated', { roomId: roomId });
    console.log(`ルーム ${roomId} 作成: ${hostName}`);
}

function joinRoom(socket, roomId, clientName) {
    const room = rooms.get(roomId);
    if (!room) {
        socket.emit('error', { message: 'ルームが見つかりません' });
        return;
    }

    socket.roomId = roomId;
    socket.isHost = false;
    socket.displayName = clientName || `メンバー`;
    room.clients.add(socket);

    socket.join(roomId);

    // 参加者に現在の状態を送信
    socket.emit('joinedRoom', {
        roomId: roomId,
        hostName: room.hostName,
        settings: room.settings
    });

    // ホストに通知
    if (room.host) {
        room.host.emit('clientJoined', {
            clientName: socket.displayName,
            clientCount: room.clients.size - 1
        });
    }

    console.log(`${socket.displayName} がルーム ${roomId} に参加`);
}

function sendAvailableRooms(socket) {
    console.log(`[${socket.id}] ルームリスト要求を受信`);
    const availableRooms = [];
    rooms.forEach((room, id) => {
        availableRooms.push({
            id: id,
            hostName: room.hostName,
            clientCount: room.clients.size - 1
        });
    });

    console.log(`[${socket.id}] ルームリスト送信: ${availableRooms.length}件`);
    socket.emit('availableRooms', { rooms: availableRooms });
}

function handleDisconnect(socket) {
    if (!socket.roomId) return;

    const room = rooms.get(socket.roomId);
    if (!room) return;

    room.clients.delete(socket);

    if (socket.isHost) {
        // ホストが切断した場合、ルームを閉じる
        io.in(socket.roomId).emit('roomClosed', { message: 'ホストが切断しました' });
        rooms.delete(socket.roomId);
        // 全員をルームから退出させる（Socket.ioの管理上は自動ではないので明示的にやるとより良いが、切断されてるのでOK）
    } else {
        // クライアント切断をホストに通知
        if (room.host) {
            room.host.emit('clientLeft', {
                clientName: socket.displayName,
                clientCount: room.clients.size - 1
            });
        }
    }
}

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// サーバー起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎵 Sync Metronome Server (Socket.io) running on port ${PORT}`);
});
