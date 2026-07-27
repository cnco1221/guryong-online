const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let rooms = {};

io.on('connection', (socket) => {
    console.log(`사용자 접속: ${socket.id}`);

    socket.on('joinRoom', (roomCode) => {
        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                players: [],
                hands: { p1: [1,2,3,4,5,6,7,8,9], p2: [1,2,3,4,5,6,7,8,9] },
                selected: { p1: null, p2: null },
                wins: { p1: 0, p2: 0 },
                turn: null,
                subStep: 1,
                history: [] // 이전 턴들에 낸 카드 기록
            };
        }

        const room = rooms[roomCode];
        
        if (!room.players.includes(socket.id)) {
            if (room.players.length >= 2) {
                socket.emit('errorMsg', '방이 가득 찼습니다.');
                return;
            }
            room.players.push(socket.id);
        }

        socket.join(roomCode);
        socket.roomCode = roomCode;
        
        const playerIndex = room.players.indexOf(socket.id);
        socket.playerRole = playerIndex === 0 ? 'p1' : 'p2';

        socket.emit('assignedRole', socket.playerRole);

        if (room.players.length === 2 && !room.turn) {
            room.turn = Math.random() < 0.5 ? 'p1' : 'p2';
            room.subStep = 1;
        }

        io.to(roomCode).emit('updateState', room);
    });

    socket.on('selectCard', ({ roomCode, card }) => {
        const room = rooms[roomCode];
        if (!room) return;

        if (socket.playerRole !== room.turn) return;

        if (socket.playerRole === 'p1') {
            room.selected.p1 = card;
            room.hands.p1 = room.hands.p1.filter(c => c !== card);
        } else {
            room.selected.p2 = card;
            room.hands.p2 = room.hands.p2.filter(c => c !== card);
        }

        if (room.subStep === 1) {
            room.subStep = 2;
            room.turn = (room.turn === 'p1') ? 'p2' : 'p1';
            io.to(roomCode).emit('updateState', room);
        } 
        else if (room.subStep === 2) {
            io.to(roomCode).emit('updateState', room);

            const c1 = room.selected.p1;
            const c2 = room.selected.p2;
            let roundWinner = null;

            if (c1 === 1 && c2 === 9) roundWinner = 'p1';
            else if (c2 === 1 && c1 === 9) roundWinner = 'p2';
            else if (c1 > c2) roundWinner = 'p1';
            else if (c2 > c1) roundWinner = 'p2';

            if (roundWinner) room.wins[roundWinner]++;

            // 이번 턴의 기록을 히스토리에 추가 (내 카드, 상대 카드를 철저히 본인 시점에 맞추기 위해 객체로 저장)
            room.history.push({ p1Card: c1, p2Card: c2, winner: roundWinner });

            io.to(roomCode).emit('roundResult', { winner: roundWinner });

            setTimeout(() => {
                if (room.wins.p1 >= 5 || room.wins.p2 >= 5) {
                    io.to(roomCode).emit('gameOver', roundWinner);
                    room.wins = { p1: 0, p2: 0 };
                    room.hands = { p1: [1,2,3,4,5,6,7,8,9], p2: [1,2,3,4,5,6,7,8,9] };
                    room.history = [];
                }
                room.selected = { p1: null, p2: null };
                room.subStep = 1;
                room.turn = roundWinner ? roundWinner : (Math.random() < 0.5 ? 'p1' : 'p2');
                io.to(roomCode).emit('updateState', room);
            }, 3000);
        }
    });

    socket.on('disconnect', () => {
        if (socket.roomCode && rooms[socket.roomCode]) {
            delete rooms[socket.roomCode];
            io.to(socket.roomCode).emit('errorMsg', '상대방이 나갔습니다.');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`서버 실행 중 (Port: ${PORT})`);
});
