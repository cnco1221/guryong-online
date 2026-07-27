const express = require('http');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

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
                turn: null, // 이번 판의 선공 (먼저 카드를 내야 하는 사람)
                gameOver: false
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

        // 두 플레이어가 모두 입장하고 게임 시작 전인 경우 초기 선공 결정 (랜덤)
        if (room.players.length === 2 && room.turn === null && !room.gameOver) {
            room.turn = Math.random() < 0.5 ? 'p1' : 'p2';
        }

        io.to(roomCode).emit('updateState', room);
    });

    socket.on('selectCard', ({ roomCode, card }) => {
        const room = rooms[roomCode];
        if (!room || room.gameOver) return;

        const role = room.players[0] === socket.id ? 'p1' : 'p2';
        const oppRole = role === 'p1' ? 'p2' : 'p1';

        // 이미 냈거나 손패에 없는 카드면 무시
        if (room.selected[role] !== null) return;
        if (!room.hands[role].includes(card)) return;

        // 선공/후공 규칙 검증: 선공이 아직 안 냈는데 후공이 먼저 내려 하는 경우 방지
        if (room.selected[room.turn] === null && role !== room.turn) {
            return; // 선공이 먼저 내야 함
        }

        // 카드 선택 반영
        room.selected[role] = card;

        // 두 플레이어 모두 카드를 냈는지 확인 (라운드 정산)
        if (room.selected.p1 !== null && room.selected.p2 !== null) {
            const p1Card = room.selected.p1;
            const p2Card = room.selected.p2;

            // 손패에서 제거
            room.hands.p1 = room.hands.p1.filter(c => c !== p1Card);
            room.hands.p2 = room.hands.p2.filter(c => c !== p2Card);

            let roundWinner = null;
            if (p1Card > p2Card) {
                // 단, 구룡투 특수 룰(9와 1 처리 등) 필요시 적용 가능하나 기본 대소 비교
                if (!(p1Card === 9 && p2Card === 1)) {
                    roundWinner = 'p1';
                } else {
                    roundWinner = 'p2'; // 9 vs 1 특수룰 예시 (필요시 조정)
                }
            } else if (p2Card > p1Card) {
                if (!(p2Card === 9 && p1Card === 1)) {
                    roundWinner = 'p2';
                } else {
                    roundWinner = 'p1';
                }
            }

            // 승점 반영
            if (roundWinner) {
                room.wins[roundWinner]++;
            }

            // 히스토리 기록 저장
            room.history.push({
                p1Card,
                p2Card,
                winner: roundWinner
            });

            io.to(roomCode).emit('roundResult', { winner: roundWinner });

            // 게임 종료 조건 확인 (손패가 모두 소진되었거나 9라운드 완료)
            if (room.history.length >= 9 || room.hands.p1.length === 0) {
                room.gameOver = true;
                let finalWinner = 'draw';
                if (room.wins.p1 > room.wins.p2) finalWinner = 'p1';
                else if (room.wins.p2 > room.wins.p1) finalWinner = 'p2';

                setTimeout(() => {
                    io.to(roomCode).emit('gameOver', { winner: finalWinner, history: room.history });
                }, 1000);
            } else {
                // 다음 턴 선공 설정: 이번 라운드 승리자, 비겼을 경우 기존 선공 유지
                if (roundWinner) {
                    room.turn = roundWinner;
                }
                // 선택 초기화 후 상태 전송
                room.selected.p1 = null;
                room.selected.p2 = null;
            }
        }

        io.to(roomCode).emit('updateState', room);
    });

    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const index = room.players.indexOf(socket.id);
            if (index !== -1) {
                room.players.splice(index, 1);
                if (room.players.length === 0) {
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
