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
                wins: { p1: 0, p2: 0 }
            };
        }

        const room = rooms[roomCode];
        
        // 이미 방에 있는 사용자가 재접속한 경우가 아니라면 인원 체크
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
        io.to(roomCode).emit('updateState', room);
        console.log(`[방: ${roomCode}] 플레이어 입장: ${socket.playerRole} (${socket.id})`);
    });

    socket.on('selectCard', ({ roomCode, card }) => {
        const room = rooms[roomCode];
        if (!room) return;

        if (socket.playerRole === 'p1' && room.selected.p1 === null) {
            room.selected.p1 = card;
            room.hands.p1 = room.hands.p1.filter(c => c !== card);
        } else if (socket.playerRole === 'p2' && room.selected.p2 === null) {
            room.selected.p2 = card;
            room.hands.p2 = room.hands.p2.filter(c => c !== card);
        }

        io.to(roomCode).emit('updateState', room);

        // 두 플레이어 모두 카드를 냈을 경우 승부 판정
        if (room.selected.p1 !== null && room.selected.p2 !== null) {
            const c1 = room.selected.p1;
            const c2 = room.selected.p2;
            let roundWinner = null;

            if (c1 === 1 && c2 === 9) roundWinner = 'p1';
            else if (c2 === 1 && c1 === 9) roundWinner = 'p2';
            else if (c1 > c2) roundWinner = 'p1';
            else if (c2 > c1) roundWinner = 'p2';

            if (roundWinner) room.wins[roundWinner]++;

            io.to(roomCode).emit('roundResult', { c1, c2, winner: roundWinner, wins: room.wins });

            setTimeout(() => {
                if (room.wins.p1 >= 5 || room.wins.p2 >= 5) {
                    io.to(roomCode).emit('gameOver', roundWinner);
                    room.wins = { p1: 0, p2: 0 };
                    room.hands = { p1: [1,2,3,4,5,6,7,8,9], p2: [1,2,3,4,5,6,7,8,9] };
                }
                room.selected = { p1: null, p2: null };
                io.to(roomCode).emit('updateState', room);
            }, 3000);
        }
    });

    socket.on('disconnect', () => {
        if (socket.roomCode && rooms[socket.roomCode]) {
            delete rooms[socket.roomCode];
            io.to(socket.roomCode).emit('errorMsg', '상대 플레이어가 나갔습니다.');
        }
        console.log(`사용자 퇴장: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`서버 실행 중 (Port: ${PORT})`);
});
