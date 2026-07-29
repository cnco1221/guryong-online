const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I 제외
const INACTIVITY_LIMIT_MS = 15 * 60 * 1000; // 15분 동안 진행 없으면 자동 종료
const INACTIVITY_CHECK_INTERVAL_MS = 30 * 1000; // 30초마다 점검
const CHAT_LIMIT = 200; // 채팅 기록 최대 보관 개수
const CHAT_MESSAGE_MAX_LEN = 200;

let lobbyChat = []; // 방 목록(로비) 공용 채팅 - 서버 실행 중 유지
const connectedNicknames = {}; // socket.id -> 닉네임(설정 전이면 null)

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

function touchActivity(room) {
    room.lastActivity = Date.now();
}

function createRoomEntry(roomCode) {
    rooms[roomCode] = {
        players: [],
        spectators: [], // 관전자 socket.id 목록
        nicknames: {}, // socket.id -> nickname (플레이어+관전자 공용)
        hands: {
            p1: [1, 2, 3, 4, 5, 6, 7, 8, 9],
            p2: [1, 2, 3, 4, 5, 6, 7, 8, 9]
        },
        selected: { p1: null, p2: null },
        wins: { p1: 0, p2: 0 },
        history: [],
        turn: null, // 현재 라운드의 선공 플레이어 ('p1' 또는 'p2'). null이면 게임이 아직 시작 안 된 상태
        gameOver: false,
        guestReady: false, // 게스트(두 번째로 입장한 플레이어)가 게임 준비를 완료했는지
        lastEmojiAt: {},
        lastActivity: Date.now(), // 마지막으로 "진행"(입장/카드 제출)이 있었던 시각
        chat: [] // 이 방(플레이어+관전자 공용) 채팅 기록. 방이 삭제되면 함께 사라짐
    };
}

function getRoomListPayload() {
    return Object.keys(rooms).map((code) => {
        const room = rooms[code];
        return {
            roomCode: code,
            playerCount: room.players.length,
            spectatorCount: (room.spectators || []).length,
            status: room.players.length < 2 ? 'waiting' : (room.gameOver ? 'finished' : (room.turn !== null ? 'playing' : 'waiting')),
            hostNickname: room.nicknames[room.players[0]] || null,
            guestNickname: room.nicknames[room.players[1]] || null
        };
    }).sort((a, b) => a.roomCode.localeCompare(b.roomCode));
}

function broadcastRoomList() {
    io.emit('roomList', getRoomListPayload());
}

function getOnlineUsersPayload() {
    return Object.values(connectedNicknames).map((n) => n || '플레이어');
}

function broadcastOnlineUsers() {
    io.emit('onlineUsers', getOnlineUsersPayload());
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
    touchActivity(room);

    if (connectedNicknames[socket.id] !== room.nicknames[socket.id]) {
        connectedNicknames[socket.id] = room.nicknames[socket.id];
        broadcastOnlineUsers();
    }

    const role = room.players[0] === socket.id ? 'p1' : 'p2';
    socket.emit('assignedRole', role);

    io.to(roomCode).emit('updateState', room);
    socket.emit('roomChatHistory', room.chat || []);
    broadcastRoomList();
}

io.on('connection', (socket) => {
    connectedNicknames[socket.id] = null;
    broadcastOnlineUsers();
    socket.emit('roomList', getRoomListPayload());
    socket.emit('lobbyChatHistory', lobbyChat);

    socket.on('getRoomList', () => {
        socket.emit('roomList', getRoomListPayload());
    });

    // 로비에서 닉네임을 입력/수정할 때마다 접속자 목록에 실시간 반영
    socket.on('setNickname', ({ nickname } = {}) => {
        const trimmed = (typeof nickname === 'string') ? nickname.trim().slice(0, 8) : '';
        connectedNicknames[socket.id] = trimmed || null;
        broadcastOnlineUsers();
    });

    // ===== 채팅 =====
    socket.on('getLobbyChat', () => {
        socket.emit('lobbyChatHistory', lobbyChat);
    });

    socket.on('sendLobbyChat', ({ nickname, message } = {}) => {
        if (typeof nickname !== 'string' || !nickname.trim()) return; // 닉네임 설정한 사람만 채팅 가능
        if (typeof message !== 'string') return;
        const text = message.trim().slice(0, CHAT_MESSAGE_MAX_LEN);
        if (!text) return;

        const entry = { nickname: sanitizeNickname(nickname), message: text, timestamp: Date.now() };
        lobbyChat.push(entry);
        if (lobbyChat.length > CHAT_LIMIT) lobbyChat.shift();
        io.emit('lobbyChatMessage', entry);
    });

    socket.on('sendRoomChat', ({ roomCode, message } = {}) => {
        if (!roomCode || typeof roomCode !== 'string') return;
        roomCode = roomCode.trim().toUpperCase();
        const room = rooms[roomCode];
        if (!room) return;

        // 이 방의 플레이어 또는 관전자이면서 닉네임이 설정된 사람만 채팅 가능
        const nickname = room.nicknames[socket.id];
        if (!nickname) return;
        const isOccupant = room.players.includes(socket.id) || (room.spectators && room.spectators.includes(socket.id));
        if (!isOccupant) return;

        if (typeof message !== 'string') return;
        const text = message.trim().slice(0, CHAT_MESSAGE_MAX_LEN);
        if (!text) return;

        if (!room.chat) room.chat = [];
        const entry = { nickname, message: text, timestamp: Date.now() };
        room.chat.push(entry);
        if (room.chat.length > CHAT_LIMIT) room.chat.shift();
        io.to(roomCode).emit('roomChatMessage', entry);
    });
    // ===== 채팅 끝 =====

    socket.on('createRoom', ({ nickname } = {}) => {
        const roomCode = generateRoomCode();
        createRoomEntry(roomCode);
        socket.emit('roomCreated', roomCode);
        joinRoomInternal(socket, roomCode, nickname);
    });

    socket.on('joinRoom', ({ roomCode, nickname } = {}) => {
        joinRoomInternal(socket, roomCode, nickname);
    });

    socket.on('spectateRoom', ({ roomCode, nickname } = {}) => {
        if (!roomCode || typeof roomCode !== 'string') {
            socket.emit('joinError', '올바르지 않은 방 코드입니다.');
            return;
        }
        roomCode = roomCode.trim().toUpperCase();
        const room = rooms[roomCode];
        if (!room) {
            socket.emit('joinError', '존재하지 않는 방입니다.');
            return;
        }

        if (!room.spectators) room.spectators = [];
        if (!room.spectators.includes(socket.id)) {
            room.spectators.push(socket.id);
        }
        room.nicknames[socket.id] = sanitizeNickname(nickname);
        socket.join(roomCode);
        socket.data.roomCode = roomCode;
        socket.data.isSpectator = true;

        if (connectedNicknames[socket.id] !== room.nicknames[socket.id]) {
            connectedNicknames[socket.id] = room.nicknames[socket.id];
            broadcastOnlineUsers();
        }

        socket.emit('assignedRole', 'spectator');
        socket.emit('updateState', room);
        socket.emit('roomChatHistory', room.chat || []);
        broadcastRoomList();
    });

    // ===== 게임 준비 / 시작 =====
    socket.on('toggleReady', ({ roomCode } = {}) => {
        if (!roomCode || typeof roomCode !== 'string') return;
        roomCode = roomCode.trim().toUpperCase();
        const room = rooms[roomCode];
        if (!room || room.players.length < 2 || room.turn !== null) return;

        // 게스트(두 번째로 입장한 플레이어)만 준비 상태를 토글할 수 있음
        if (room.players[1] !== socket.id) return;

        room.guestReady = !room.guestReady;
        touchActivity(room);
        io.to(roomCode).emit('updateState', room);
    });

    socket.on('startGame', ({ roomCode } = {}) => {
        if (!roomCode || typeof roomCode !== 'string') return;
        roomCode = roomCode.trim().toUpperCase();
        const room = rooms[roomCode];
        if (!room || room.players.length < 2 || room.turn !== null || room.gameOver) return;

        // 방장(첫 번째로 입장한 플레이어)만 게임을 시작할 수 있고, 게스트가 준비를 마쳐야 함
        if (room.players[0] !== socket.id) return;
        if (!room.guestReady) {
            socket.emit('actionError', '상대방이 아직 준비하지 않았습니다.');
            return;
        }

        room.turn = Math.random() < 0.5 ? 'p1' : 'p2';
        touchActivity(room);
        io.to(roomCode).emit('updateState', room);
    });
    // ===== 게임 준비 / 시작 끝 =====

    socket.on('leaveSpectate', ({ roomCode } = {}, callback) => {
        if (!roomCode || typeof roomCode !== 'string') {
            if (typeof callback === 'function') callback();
            return;
        }
        roomCode = roomCode.trim().toUpperCase();
        const room = rooms[roomCode];
        if (!room || !room.spectators) {
            if (typeof callback === 'function') callback();
            return;
        }

        const idx = room.spectators.indexOf(socket.id);
        if (idx !== -1) {
            room.spectators.splice(idx, 1);
            delete room.nicknames[socket.id];
        }
        socket.leave(roomCode);
        socket.data.isSpectator = false;
        broadcastRoomList();
        if (typeof callback === 'function') callback();
    });

    // 게임이 시작되기 전(상대가 아직 입장하지 않은 상태)에만 플레이어가 방을 나갈 수 있음
    socket.on('leaveRoom', ({ roomCode } = {}, callback) => {
        if (!roomCode || typeof roomCode !== 'string') {
            if (typeof callback === 'function') callback();
            return;
        }
        roomCode = roomCode.trim().toUpperCase();
        const room = rooms[roomCode];
        if (!room) {
            if (typeof callback === 'function') callback();
            return;
        }

        const idx = room.players.indexOf(socket.id);
        if (idx === -1) {
            if (typeof callback === 'function') callback();
            return; // 이 방의 플레이어가 아니면 무시 (관전자는 leaveSpectate 사용)
        }

        if (room.turn !== null) {
            // room.turn은 두 플레이어가 모두 모이는 순간 배정됨 -> 이미 게임이 시작된 상태
            // (버튼이 이 시점엔 숨겨져 있어야 하므로 정상 흐름에서는 거의 발생하지 않음)
            socket.emit('errorMsg', '게임이 이미 시작되어 나갈 수 없습니다.');
            if (typeof callback === 'function') callback();
            return;
        }

        room.players.splice(idx, 1);
        delete room.nicknames[socket.id];
        room.guestReady = false; // 인원 변동 -> 다음 게스트를 위해 준비 상태 초기화
        socket.leave(roomCode);

        if (room.players.length === 0 && (!room.spectators || room.spectators.length === 0)) {
            delete rooms[roomCode];
        } else {
            io.to(roomCode).emit('updateState', room);
        }
        broadcastRoomList();
        if (typeof callback === 'function') callback();
    });

    socket.on('selectCard', ({ roomCode, card }) => {
        const room = rooms[roomCode];
        if (!room || room.gameOver) return;
        if (!room.players.includes(socket.id)) return; // 관전자는 카드 제출 불가

        const role = room.players[0] === socket.id ? 'p1' : 'p2';
        const oppRole = role === 'p1' ? 'p2' : 'p1';

        if (room.selected[role] !== null) return;
        if (!room.hands[role].includes(card)) return;

        // 선공 고정 규칙: 선공이 아직 내지 않았다면 후공은 먼저 낼 수 없음
        if (room.selected[room.turn] === null && role !== room.turn) {
            return;
        }

        room.selected[role] = card;
        touchActivity(room);

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
                    if (!rooms[roomCode]) return; // 그 사이 방이 다른 사유로 사라졌을 수 있음
                    io.to(roomCode).emit('gameOver', { winner: finalWinner, history: room.history });

                    // 방을 삭제하지 않고 다음 게임을 위해 초기화 -> 같은 방에서 바로 재대결 가능
                    room.hands = {
                        p1: [1, 2, 3, 4, 5, 6, 7, 8, 9],
                        p2: [1, 2, 3, 4, 5, 6, 7, 8, 9]
                    };
                    room.selected = { p1: null, p2: null };
                    room.wins = { p1: 0, p2: 0 };
                    room.history = [];
                    room.turn = null;
                    room.gameOver = false;
                    room.guestReady = false; // 다음 게임을 위해 게스트는 다시 준비해야 함
                    touchActivity(room);

                    io.to(roomCode).emit('updateState', room);
                    broadcastRoomList();
                }, 1000);
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
            let changed = false;

            const index = room.players.indexOf(socket.id);
            if (index !== -1) {
                room.players.splice(index, 1);
                delete room.nicknames[socket.id];
                room.guestReady = false; // 인원 변동 -> 다음 게스트를 위해 준비 상태 초기화
                changed = true;
                if (room.players.length === 0 && (!room.spectators || room.spectators.length === 0)) {
                    delete rooms[roomCode];
                    broadcastRoomList();
                    continue;
                } else {
                    io.to(roomCode).emit('errorMsg', '상대방이 나갔습니다.');
                }
            }

            if (room.spectators) {
                const specIndex = room.spectators.indexOf(socket.id);
                if (specIndex !== -1) {
                    room.spectators.splice(specIndex, 1);
                    delete room.nicknames[socket.id];
                    changed = true;
                    if (room.players.length === 0 && room.spectators.length === 0) {
                        delete rooms[roomCode];
                        broadcastRoomList();
                        continue;
                    }
                }
            }

            if (changed) broadcastRoomList();
        }
        delete connectedNicknames[socket.id];
        broadcastOnlineUsers();
    });
});

// 15분 이상 진행(입장/카드 제출)이 없는 방은 자동으로 종료
function cleanupInactiveRooms() {
    const now = Date.now();
    let changed = false;

    for (const roomCode in rooms) {
        const room = rooms[roomCode];
        const last = room.lastActivity || 0;
        if (now - last >= INACTIVITY_LIMIT_MS) {
            io.to(roomCode).emit('errorMsg', '15분 동안 진행이 없어 방이 자동으로 종료되었습니다.');
            delete rooms[roomCode];
            changed = true;
        }
    }

    if (changed) broadcastRoomList();
}

setInterval(cleanupInactiveRooms, INACTIVITY_CHECK_INTERVAL_MS);

server.listen(3000, () => {
    console.log('Server running on port 3000');
});
