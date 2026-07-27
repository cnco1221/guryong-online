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
                history: []
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

            // 구룡투 규칙: 1은 9를 이긴다
            if (c1 === 1 && c2 === 9) roundWinner = 'p1';
            else if (c2 === 1 && c1 === 9) roundWinner = 'p2';
            else if (c1 > c2) roundWinner = 'p1';
            else if (c2 > c1) roundWinner = 'p2';
            else {
                // 비겼을 경우 기존 선공 유지
                roundWinner = (room.turn === 'p1') ? 'p2' : 'p1';
            }

            if (c1 !== c2) {
                room.wins[roundWinner]++;
            }

            room.history.push({ p1Card: c1, p2Card: c2, winner: (c1 === c2) ? null : roundWinner });

            io.to(roomCode).emit('roundResult', { winner: (c1 === c2) ? null : roundWinner });

            setTimeout(() => {
                // 게임 종료 조건: 5승 달성 OR 9장 모두 소진
                if (room.wins.p1 >= 5 || room.wins.p2 >= 5 || room.history.length >= 9) {
                    let finalWinner = null;
                    if (room.wins.p1 >= 5) {
                        finalWinner = 'p1';
                    } else if (room.wins.p2 >= 5) {
                        finalWinner = 'p2';
                    } else {
                        // 9장 다 썼는데 5승이 안 나온 경우 승수 비교
                        if (room.wins.p1 > room.wins.p2) finalWinner = 'p1';
                        else if (room.wins.p2 > room.wins.p1) finalWinner = 'p2';
                        else finalWinner = 'draw'; // 동점이면 무승부
                    }

                    // 게임 종료 시 전체 기록(history)을 함께 전달
                    io.to(roomCode).emit('gameOver', { winner: finalWinner, history: room.history });
                    
                    room.wins = { p1: 0, p2: 0 };
                    room.hands = { p1: [1,2,3,4,5,6,7,8,9], p2: [1,2,3,4,5,6,7,8,9] };
                    room.history = [];
                    room.turn = Math.random() < 0.5 ? 'p1' : 'p2';
                } else {
                    room.turn = roundWinner;
                }
                room.selected = { p1: null, p2: null };
                room.subStep = 1;
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
