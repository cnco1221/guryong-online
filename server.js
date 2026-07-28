const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};
const TURN_SECONDS = 20;
const EMOJI_COUNT = 4; // public/emojis/e1.png ~ e4.png

function clearRoomTimer(room) {
    if (room.timerHandle) {
        clearTimeout(room.timerHandle);
        room.timerHandle = null;
    }
    room.timerRole = null;
    room.timerEnd = null;
}

// 특정 플레이어(role)가 카드를 낼 차례임을 알리고, 시간 초과 시 자동으로 카드를 제출시키는 타이머 시작
function startTurnTimer(roomCode, role) {
    const room = rooms[roomCode];
    if (!room || room.gameOver) return;

    clearRoomTimer(room);
    room.timerRole = role;
    room.timerEnd = Date.now() + TURN_SECONDS * 1000;

    io.to(roomCode).emit('turnTimer', { role, duration: TURN_SECONDS });

    room.timerHandle = setTimeout(() => {
        const r = rooms[roomCode];
        if (!r || r.gameOver) return;
        if (r.selected[role] !== null) return; // 이미 제출함
        const hand = r.hands[role];
        if (!hand || hand.length === 0) return;

        const randomCard = hand[Math.floor(Math.random() * hand.length)];
        processSelection(roomCode, role, randomCard);
    }, TURN_SECONDS * 1000);
}

// 카드 제출 처리 (사용자 클릭 / 시간 초과 자동 제출 공통 로직)
function processSelection(roomCode, role, card) {
    const room = rooms[roomCode];
    if (!room || room.gameOver) return;
    if (room.selected[role] !== null) return;
    if (!room.hands[role].includes(card)) return;

    const oppRole = role === 'p1' ? 'p2' : 'p1';

    // 선공 고정 규칙: 선공이 아직 내지 않았다면 후공은 먼저 낼 수 없음
    if (room.selected[room.turn] === null && role !== room.turn) {
        return;
    }

    room.selected[role] = card;

    // 양쪽 다 카드를 제출했을 경우 정산
    if (room.selected.p1 !== null && room.selected.p2 !== null) {
        clearRoomTimer(room);

        const p1Card = room.selected.p1;
        const p2Card = room.selected.p2;

        room.hands.p1 = room.hands.p1.filter(c => c !== p1Card);
        room.hands.p2 = room.hands.p2.filter(c => c !== p2Card);

        let roundWinner = null;
        if (p1Card > p2Card) {
            roundWinner = (p1Card === 9 && p2Card === 1) ? 'p2' : 'p1';
        } else if (p2Card > p1Card) {
            roundWinner = (p2Card === 9 && p1Card === 1) ? 'p1' : 'p2';
        }

        if (roundWinner) {
            room.wins[roundWinner]++;
        }

        room.history.push({ p1Card, p2Card, winner: roundWinner });

        io.to(roomCode).emit('roundResult', { winner: roundWinner });

        if (room.history.length >= 9 || room.hands.p1.length === 0 || room.wins.p1 >= 5 || room.wins.p2 >= 5) {
            room.gameOver = true;
            let finalWinner = 'draw';
            if (room.wins.p1 > room.wins.p2) finalWinner = 'p1';
            else if (room.wins.p2 > room.wins.p1) finalWinner = 'p2';

            setTimeout(() => {
                io.to(roomCode).emit('gameOver', { winner: finalWinner, history: room.history });
            }, 1000);
        } else {
            // 라운드 승자가 다음 라운드 선공 (무승부 시 기존 선공 유지)
            if (roundWinner) {
                room.turn = roundWinner;
            }
            room.selected.p1 = null;
            room.selected.p2 = null;
            startTurnTimer(roomCode, room.turn);
        }
    } else {
        // 한쪽만 제출한 상태 -> 상대방 행동 타이머 시작
        startTurnTimer(roomCode, oppRole);
    }

    io.to(roomCode).emit('updateState', room);
}

io.on('connection', (socket) => {
    socket.on('joinRoom', (roomCode) => {
        socket.join(roomCode);

        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                players: [],
                hands: {
                    p1: [1, 2, 3, 4, 5, 6, 7, 8, 9],
                    p2: [1, 2, 3, 4, 5, 6, 7, 8, 9]
                },
                selected: { p1: null, p2: null },
                wins: { p1: 0, p2: 0 },
                history: [],
                turn: null, // 현재 라운드의 선공 플레이어 ('p1' 또는 'p2')
                gameOver: false,
                timerHandle: null,
                timerRole: null,
                timerEnd: null
            };
        }

        const room = rooms[roomCode];

        if (!room.players.includes(socket.id)) {
            if (room.players.length < 2) {
                room.players.push(socket.id);
            }
        }

        const role = room.players[0] === socket.id ? 'p1' : (room.players[1] === socket.id ? 'p2' : null);
        if (!role) {
            socket.emit('errorMsg', '방이 꽉 찼습니다.');
            return;
        }

        socket.emit('assignedRole', role);

        // 두 명이 모두 모였을 때 최초 선공 무작위 설정 + 타이머 시작
        if (room.players.length === 2 && room.turn === null && !room.gameOver) {
            room.turn = Math.random() < 0.5 ? 'p1' : 'p2';
            startTurnTimer(roomCode, room.turn);
        }

        io.to(roomCode).emit('updateState', room);

        // 재접속 등으로 이미 타이머가 돌아가고 있다면 남은 시간을 알려줌 (기존 타이머는 그대로 유지)
        if (!room.gameOver && room.timerRole && room.timerEnd) {
            const remaining = Math.max(0, Math.ceil((room.timerEnd - Date.now()) / 1000));
            socket.emit('turnTimer', { role: room.timerRole, duration: remaining });
        }
    });

    socket.on('selectCard', ({ roomCode, card }) => {
        const room = rooms[roomCode];
        if (!room || room.gameOver) return;
        const role = room.players[0] === socket.id ? 'p1' : 'p2';
        processSelection(roomCode, role, card);
    });

    socket.on('sendEmoji', ({ roomCode, emojiId }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const id = Number(emojiId);
        if (!Number.isInteger(id) || id < 1 || id > EMOJI_COUNT) return;

        const role = room.players[0] === socket.id ? 'p1' : (room.players[1] === socket.id ? 'p2' : null);
        if (!role) return;

        io.to(roomCode).emit('emojiReceived', { role, emojiId: id });
    });

    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const index = room.players.indexOf(socket.id);
            if (index !== -1) {
                room.players.splice(index, 1);
                if (room.players.length === 0) {
                    clearRoomTimer(room);
                    delete rooms[roomCode];
                } else {
                    io.to(roomCode).emit('errorMsg', '상대방이 나갔습니다.');
                }
            }
        }
    });
});

server.listen(3000, () => {
    console.log('Server running on port 3000');
});
