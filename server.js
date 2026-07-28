const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I 제외

function generateRoomCode() {
    let code;
    do {
        code = '';
        for (let i = 0; i < 5; i++) {
            code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
        }
    } while (rooms[code]);
    return code;
}

function sanitizeNickname(nickname) {
    if (typeof nickname !== 'string') return '익명';
    const trimmed = nickname.trim().slice(0, 8);
    return trimmed.length > 0 ? trimmed : '익명';
}

function createRoomEntry(roomCode) {
    rooms[roomCode] = {
        players: [],
        nicknames: {}, // socket.id -> nickname
        hands: {
            p1: [1, 2, 3, 4, 5, 6, 7, 8, 9],
            p2: [1, 2, 3, 4, 5, 6, 7, 8, 9]
        },
        selected: { p1: null, p2: null },
        wins: { p1: 0, p2: 0 },
        history: [],
        turn: null, // 현재 라운드의 선공 플레이어 ('p1' 또는 'p2')
        gameOver: false,
        lastEmojiAt: {}
    };
}

function getRoomListPayload() {
    return Object.keys(rooms).map((code) => {
        const room = rooms[code];
        return {
            roomCode: code,
            playerCount: room.players.length,
            status: room.players.length >= 2 ? (room.gameOver ? 'finished' : 'playing') : 'waiting',
            hostNickname: room.nicknames[room.players[0]] || null,
            guestNickname: room.nicknames[room.players[1]] || null
        };
    }).sort((a, b) => a.roomCode.localeCompare(b.roomCode));
}

function broadcastRoomList() {
    io.emit('roomList', getRoomListPayload());
}

function broadcastOnlineCount() {
    io.emit('onlineCount', io.engine.clientsCount);
}

// 방 참가 처리 공통 로직 (방 만들기 직후 자동 입장 / 목록에서 입장 / 코드 직접 입장 공용)
function joinRoomInternal(socket, roomCode, nickname) {
    if (!roomCode || typeof roomCode !== 'string') {
        socket.emit('joinError', '올바르지 않은 방 코드입니다.');
        return;
    }
    roomCode = roomCode.trim().toUpperCase();

    if (!rooms[roomCode]) createRoomEntry(roomCode);
    const room = rooms[roomCode];

    if (!room.players.includes(socket.id)) {
        if (room.players.length >= 2) {
            socket.emit('joinError', '방이 꽉 찼습니다.');
            return;
        }
        room.players.push(socket.id);
    }

    room.nicknames[socket.id] = sanitizeNickname(nickname);
    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    const role = room.players[0] === socket.id ? 'p1' : 'p2';
    socket.emit('assignedRole', role);

    // 두 명이 모두 모였을 때 최초 선공 무작위 설정
    if (room.players.length === 2 && room.turn === null && !room.gameOver) {
        room.turn = Math.random() < 0.5 ? 'p1' : 'p2';
    }

    io.to(roomCode).emit('updateState', room);
    broadcastRoomList();
}

io.on('connection', (socket) => {
    broadcastOnlineCount();
    socket.emit('roomList', getRoomListPayload());

    socket.on('getRoomList', () => {
        socket.emit('roomList', getRoomListPayload());
    });

    socket.on('createRoom', ({ nickname } = {}) => {
        const roomCode = generateRoomCode();
        createRoomEntry(roomCode);
        socket.emit('roomCreated', roomCode);
        joinRoomInternal(socket, roomCode, nickname);
    });

    socket.on('joinRoom', ({ roomCode, nickname } = {}) => {
        joinRoomInternal(socket, roomCode, nickname);
    });

    socket.on('selectCard', ({ roomCode, card }) => {
        const room = rooms[roomCode];
        if (!room || room.gameOver) return;

        const role = room.players[0] === socket.id ? 'p1' : 'p2';
        const oppRole = role === 'p1' ? 'p2' : 'p1';

        if (room.selected[role] !== null) return;
        if (!room.hands[role].includes(card)) return;

        // 선공 고정 규칙: 선공이 아직 내지 않았다면 후공은 먼저 낼 수 없음
        if (room.selected[room.turn] === null && role !== room.turn) {
            return;
        }

        room.selected[role] = card;

        // 양쪽 다 카드를 제출했을 경우 정산
        if (room.selected.p1 !== null && room.selected.p2 !== null) {
            const p1Card = room.selected.p1;
            const p2Card = room.selected.p2;

            room.hands.p1 = room.hands.p1.filter(c => c !== p1Card);
            room.hands.p2 = room.hands.p2.filter(c => c !== p2Card);

            let roundWinner = null;
            if (p1Card > p2Card) {
                if (!(p1Card === 9 && p2Card === 1)) {
                    roundWinner = 'p1';
                } else {
                    roundWinner = 'p2';
                }
            } else if (p2Card > p1Card) {
                if (!(p2Card === 9 && p1Card === 1)) {
                    roundWinner = 'p2';
                } else {
                    roundWinner = 'p1';
                }
            }

            if (roundWinner) {
                room.wins[roundWinner]++;
            }

            room.history.push({
                p1Card,
                p2Card,
                winner: roundWinner
            });

            io.to(roomCode).emit('roundResult', { winner: roundWinner });

            if (room.history.length >= 9 || room.hands.p1.length === 0 || room.wins.p1 >= 5 || room.wins.p2 >= 5) {
                room.gameOver = true;
                let finalWinner = 'draw';
                if (room.wins.p1 > room.wins.p2) finalWinner = 'p1';
                else if (room.wins.p2 > room.wins.p1) finalWinner = 'p2';

                setTimeout(() => {
                    io.to(roomCode).emit('gameOver', { winner: finalWinner, history: room.history });
                }, 1000);

                broadcastRoomList();
            } else {
                // 라운드 승자가 다음 라운드 선공 (무승부 시 기존 선공 유지)
                if (roundWinner) {
                    room.turn = roundWinner;
                }
                room.selected.p1 = null;
                room.selected.p2 = null;
            }
        }

        io.to(roomCode).emit('updateState', room);
    });

    socket.on('sendEmoji', ({ roomCode, emojiId }) => {
        const room = rooms[roomCode];
        if (!room) return;
        if (!room.players.includes(socket.id)) return;

        const role = room.players[0] === socket.id ? 'p1' : 'p2';

        const now = Date.now();
        if (!room.lastEmojiAt) room.lastEmojiAt = {};
        const last = room.lastEmojiAt[role] || 0;
        if (now - last < 3000) return; // 3초 쿨타임

        room.lastEmojiAt[role] = now;
        io.to(roomCode).emit('emojiReceived', { role, emojiId });
    });

    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const index = room.players.indexOf(socket.id);
            if (index !== -1) {
                room.players.splice(index, 1);
                delete room.nicknames[socket.id];
                if (room.players.length === 0) {
                    delete rooms[roomCode];
                } else {
                    io.to(roomCode).emit('errorMsg', '상대방이 나갔습니다.');
                }
                broadcastRoomList();
            }
        }
        broadcastOnlineCount();
    });
});

server.listen(3000, () => {
    console.log('Server running on port 3000');
});
