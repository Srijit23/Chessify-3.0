const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.static(path.join(__dirname)));

const gameRooms = new Map();
const onlinePlayers = new Map();
const challenges = new Map();
const CHALLENGE_TIMEOUT_MS = 30000;
const DEFAULT_TIME_SECONDS = 180;
function createClock(initialSeconds, incrementSeconds) {
    const requestedSeconds = Number(initialSeconds);
    const requestedIncrement = Number(incrementSeconds);
    const initialMs = Math.max(60000, Math.min(10800000,
        (Number.isFinite(requestedSeconds) && requestedSeconds > 0 ? requestedSeconds : DEFAULT_TIME_SECONDS) * 1000));
    const incrementMs = Math.max(0, Math.min(180000,
        (Number.isFinite(requestedIncrement) && requestedIncrement > 0 ? requestedIncrement : 0) * 1000));
    return {
        whiteMs: initialMs,
        blackMs: initialMs,
        incrementMs,
        activeColor: 'white',
        running: false,
        lastStartedAt: 0,
        timer: null
    };
}

// Settle elapsed time against the authoritative server clock. All move and
// timeout paths use this same function so a late move cannot revive an expired game.
function settleClock(room, now = Date.now()) {
    const c = room && room.clock;
    if (!c) return null;
    if (c.running && c.lastStartedAt) {
        const elapsed = Math.max(0, now - c.lastStartedAt);
        if (c.activeColor === 'white') c.whiteMs = Math.max(0, c.whiteMs - elapsed);
        else if (c.activeColor === 'black') c.blackMs = Math.max(0, c.blackMs - elapsed);
        c.lastStartedAt = now;
    }
    return c;
}
function clockSnapshot(room) {
    const c = room.clock;
    if (!c) return null;
    let whiteMs = c.whiteMs, blackMs = c.blackMs;
    if (c.running && c.lastStartedAt) {
        const elapsed = Math.max(0, Date.now() - c.lastStartedAt);
        if (c.activeColor === 'white') whiteMs = Math.max(0, whiteMs - elapsed);
        else blackMs = Math.max(0, blackMs - elapsed);
    }
    return {
        whiteMs: Math.max(0, whiteMs),
        blackMs: Math.max(0, blackMs),
        incrementMs: c.incrementMs,
        activeColor: c.activeColor,
        running: c.running
    };
}
function broadcastClock(room) {
    const payload = { type: 'clock_update', clock: clockSnapshot(room) };
    [room.white, room.black].concat(room.spectators || []).forEach(ws => send(ws, payload));
}
function stopClock(room) {
    if (room.clock && room.clock.timer) clearInterval(room.clock.timer);
    if (room.clock) {
        room.clock.running = false;
        room.clock.timer = null;
    }
}
function finishOnTimeout(room, loser) {
    if (!room || room.gameOver) return;
    room.gameOver = true;
    stopClock(room);
    const winner = loser === 'white' ? 'black' : 'white';
    const payload = {
        type: 'game_over',
        result: 'Time expired. ' + (winner === 'white' ? 'White' : 'Black') + ' wins!',
        winner,
        reason: 'timeout',
        clock: clockSnapshot(room)
    };
    [room.white, room.black].concat(room.spectators || []).forEach(ws => send(ws, payload));
}
function startClock(room) {
    if (!room || room.gameOver || !room.white || !room.black) return;
    if (!room.clock) room.clock = createClock(DEFAULT_TIME_SECONDS, 0);
    if (room.clock.timer) clearInterval(room.clock.timer);
    room.clock.running = true;
    room.clock.activeColor = 'white';
    room.clock.lastStartedAt = Date.now();
    // Tick frequently for accurate timeout detection, but do not send a clock
    // snapshot every 200ms: the client resets its interpolation anchor on each
    // snapshot, which can keep a ceil-rounded display stuck at 03:00.
    let lastClockBroadcastAt = Date.now();
    room.clock.timer = setInterval(() => {
        if (!room.clock || !room.clock.running || room.gameOver) return;
        const c = settleClock(room);
        if (c.whiteMs <= 0) return finishOnTimeout(room, 'white');
        if (c.blackMs <= 0) return finishOnTimeout(room, 'black');
        const now = Date.now();
        if (now - lastClockBroadcastAt >= 1000) {
            lastClockBroadcastAt = now;
            broadcastClock(room);
        }
    }, 100);
}
function switchClockAfterMove(room, mover) {
    const c = settleClock(room);
    if (!c || room.gameOver || !c.running || c.activeColor !== mover) return false;
    if ((mover === 'white' ? c.whiteMs : c.blackMs) <= 0) {
        finishOnTimeout(room, mover);
        return false;
    }
    if (mover === 'white') c.whiteMs = Math.min(10800000, c.whiteMs + c.incrementMs);
    else c.blackMs = Math.min(10800000, c.blackMs + c.incrementMs);
    c.activeColor = mover === 'white' ? 'black' : 'white';
    c.lastStartedAt = Date.now();
    broadcastClock(room);
    return true;
}
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function send(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function sendError(ws, message) {
    send(ws, { type: 'error', message: message });
}

function isRegistered(ws) {
    return Boolean(ws.playerId && onlinePlayers.has(ws.playerId));
}

function playerIsBusy(ws) {
    return Boolean(ws.roomId || ws.isSpectator);
}

function broadcastPlayerList() {
    const players = Array.from(onlinePlayers.values()).map(function (player) {
        return {
            playerId: player.id,
            name: player.name,
            available: !playerBusy(player.ws),
            inRoom: Boolean(player.ws.roomId),
            isSelf: false
        };
    });
    onlinePlayers.forEach(function (player) {
        send(player.ws, {
            type: 'player_list',
            players: players.map(function (entry) {
                return Object.assign({}, entry, { isSelf: entry.playerId === player.id });
            })
        });
    });
}

function playerBusy(ws) {
    return Boolean(ws.roomId || ws.isSpectator);
}

function findPendingChallengeFor(playerId) {
    for (const challenge of challenges.values()) {
        if (challenge.fromId === playerId || challenge.toId === playerId) return challenge;
    }
    return null;
}

function removeChallenge(challengeId, notifyType, message) {
    const challenge = challenges.get(challengeId);
    if (!challenge) return;
    clearTimeout(challenge.timer);
    challenges.delete(challengeId);
    if (notifyType) {
        send(challenge.fromWs, { type: notifyType, challengeId: challengeId, message: message || '' });
        send(challenge.toWs, { type: notifyType, challengeId: challengeId, message: message || '' });
    }
}

function makeRoomId() {
    let id;
    do {
        id = crypto.randomBytes(3).toString('hex').toUpperCase();
    } while (gameRooms.has(id));
    return id;
}

function startChallengeMatch(challenge) {
    const roomId = makeRoomId();
    const room = {
        white: challenge.fromWs,
        black: challenge.toWs,
        spectators: [],
        gameState: { fen: START_FEN, moves: [] },
        clock: createClock(challenge.initialSeconds, challenge.incrementSeconds)
    };
    gameRooms.set(roomId, room);
    startClock(room);

    challenge.fromWs.roomId = roomId;
    challenge.fromWs.color = 'white';
    challenge.fromWs.isSpectator = false;
    challenge.toWs.roomId = roomId;
    challenge.toWs.color = 'black';
    challenge.toWs.isSpectator = false;

    send(challenge.fromWs, { type: 'game_start', roomId: roomId, color: 'white', fen: START_FEN, opponent: challenge.toWs.playerName, clock: clockSnapshot(room) });
    send(challenge.toWs, { type: 'game_start', roomId: roomId, color: 'black', fen: START_FEN, opponent: challenge.fromWs.playerName, clock: clockSnapshot(room) });
    broadcastPlayerList();
}

wss.on('connection', function (ws) {
    console.log('New client connected');

    ws.on('message', function (rawMessage) {
        try {
            const data = JSON.parse(rawMessage.toString());
            if (!data || typeof data.type !== 'string') return sendError(ws, 'Invalid message.');

            switch (data.type) {
                case 'register_player':
                    handleRegisterPlayer(ws, data);
                    break;
                case 'create_room':
                    handleCreateRoom(ws, data);
                    break;
                case 'join_room':
                    handleJoinRoom(ws, data);
                    break;
                case 'challenge_player':
                    handleChallengePlayer(ws, data);
                    break;
                case 'accept_challenge':
                    handleAcceptChallenge(ws, data);
                    break;
                case 'decline_challenge':
                    handleDeclineChallenge(ws, data);
                    break;
                case 'make_move':
                    handleMove(ws, data);
                    break;
                case 'game_over':
                    handleGameOver(ws, data);
                    break;
                case 'chat_message':
                    handleChatMessage(ws, data);
                    break;
                case 'offer_draw':
                    handleOfferDraw(ws, data);
                    break;
                case 'draw_response':
                    handleDrawResponse(ws, data);
                    break;
                default:
                    sendError(ws, 'Unsupported message type.');
            }
        } catch (error) {
            console.error('Error processing WebSocket message:', error);
            sendError(ws, 'Could not process that request.');
        }
    });

    ws.on('close', function () {
        handlePlayerDisconnect(ws);
        console.log('Client disconnected');
    });
    ws.on('error', function (error) {
        console.error('WebSocket error:', error);
    });
});

function handleRegisterPlayer(ws, data) {
    const name = typeof data.name === 'string' ? data.name.trim().replace(/\s+/g, ' ') : '';
    if (name.length < 2 || name.length > 20) {
        return sendError(ws, 'Enter a name between 2 and 20 characters.');
    }
    if (ws.playerId && onlinePlayers.has(ws.playerId)) {
        const existing = onlinePlayers.get(ws.playerId);
        existing.name = name;
        ws.playerName = name;
        send(ws, { type: 'player_registered', playerId: ws.playerId, name: name });
        return broadcastPlayerList();
    }

    ws.playerId = crypto.randomBytes(16).toString('hex');
    ws.playerName = name;
    onlinePlayers.set(ws.playerId, { id: ws.playerId, name: name, ws: ws });
    send(ws, { type: 'player_registered', playerId: ws.playerId, name: name });
    broadcastPlayerList();
}

function handleCreateRoom(ws, data) {
    if (!isRegistered(ws)) return sendError(ws, 'Enter the lobby with your name first.');
    if (playerBusy(ws)) return sendError(ws, 'Leave your current room before creating another.');
    const roomId = typeof data.roomId === 'string' ? data.roomId.trim().toUpperCase() : '';
    if (!/^[A-Z0-9]{3,12}$/.test(roomId)) return sendError(ws, 'Room IDs must be 3–12 letters or numbers.');
    if (gameRooms.has(roomId)) return sendError(ws, 'Room already exists. Choose another room ID.');

    gameRooms.set(roomId, {
        white: ws,
        black: null,
        spectators: [],
        gameState: { fen: START_FEN, moves: [] },
        clock: createClock(DEFAULT_TIME_SECONDS, 0)
    });
    ws.roomId = roomId;
    ws.color = 'white';
    ws.isSpectator = false;
    send(ws, { type: 'room_created', roomId: roomId, color: 'white' });
    broadcastPlayerList();
}

function handleJoinRoom(ws, data) {
    if (!isRegistered(ws)) return sendError(ws, 'Enter the lobby with your name first.');
    if (playerBusy(ws)) return sendError(ws, 'Leave your current room before joining another.');
    const roomId = typeof data.roomId === 'string' ? data.roomId.trim().toUpperCase() : '';
    const room = gameRooms.get(roomId);
    if (!room) return sendError(ws, 'Room not found. Check the room ID and try again.');
    if (room.white === ws || room.black === ws) return sendError(ws, 'You are already in this room.');

    if (!room.black) {
        room.black = ws;
        ws.roomId = roomId;
        ws.color = 'black';
        ws.isSpectator = false;
        startClock(room);
        send(room.white, { type: 'game_start', roomId: roomId, color: 'white', fen: room.gameState.fen, opponent: room.black.playerName, clock: clockSnapshot(room) });
        send(ws, { type: 'game_start', roomId: roomId, color: 'black', fen: room.gameState.fen, opponent: room.white.playerName, clock: clockSnapshot(room) });
    } else {
        room.spectators.push(ws);
        ws.roomId = roomId;
        ws.isSpectator = true;
        send(ws, { type: 'spectate_start', roomId: roomId, fen: room.gameState.fen });
    }
    broadcastPlayerList();
}

function clampChallengeTime(value) { const n = Number(value); return Number.isFinite(n) ? Math.max(60, Math.min(10800, Math.round(n))) : DEFAULT_TIME_SECONDS; }
function clampChallengeIncrement(value) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(180, Math.round(n))) : 0; }

function handleChallengePlayer(ws, data) {
    if (!isRegistered(ws)) return sendError(ws, 'Enter the lobby with your name first.');
    if (playerBusy(ws)) return sendError(ws, 'Leave your current room before challenging someone.');
    const targetId = typeof data.targetPlayerId === 'string' ? data.targetPlayerId : '';
    const target = onlinePlayers.get(targetId);
    if (!target || target.ws.readyState !== WebSocket.OPEN) return sendError(ws, 'That player is no longer online.');
    if (target.ws === ws) return sendError(ws, 'You cannot challenge yourself.');
    if (playerBusy(target.ws)) return sendError(ws, 'That player is currently in a room.');
    if (findPendingChallengeFor(ws.playerId) || findPendingChallengeFor(targetId)) {
        return sendError(ws, 'One of you already has a pending challenge. Please try again shortly.');
    }

    const challengeId = crypto.randomBytes(12).toString('hex');
    const challenge = {
        id: challengeId,
        fromId: ws.playerId,
        toId: targetId,
        fromWs: ws,
        toWs: target.ws,
        timer: null,
        initialSeconds: clampChallengeTime(data.initialSeconds),
        incrementSeconds: clampChallengeIncrement(data.incrementSeconds)
    };
    challenge.timer = setTimeout(function () {
        removeChallenge(challengeId, 'challenge_expired', 'Challenge expired.');
    }, CHALLENGE_TIMEOUT_MS);
    challenges.set(challengeId, challenge);

    send(ws, { type: 'challenge_sent', challengeId: challengeId, targetName: target.name });
    send(target.ws, {
        type: 'incoming_challenge',
        challengeId: challengeId,
        fromPlayerId: ws.playerId,
        fromName: ws.playerName,
        expiresIn: CHALLENGE_TIMEOUT_MS,
        initialSeconds: challenge.initialSeconds,
        incrementSeconds: challenge.incrementSeconds
    });
}

function handleAcceptChallenge(ws, data) {
    const challenge = challenges.get(data.challengeId);
    if (!challenge || challenge.toWs !== ws) return sendError(ws, 'That challenge is no longer available.');
    if (!isRegistered(challenge.fromWs) || !isRegistered(challenge.toWs) ||
        challenge.fromWs.readyState !== WebSocket.OPEN || challenge.toWs.readyState !== WebSocket.OPEN ||
        playerBusy(challenge.fromWs) || playerBusy(challenge.toWs)) {
        removeChallenge(challenge.id, 'challenge_expired', 'A player is no longer available.');
        return sendError(ws, 'A player is no longer available for this match.');
    }
    clearTimeout(challenge.timer);
    challenges.delete(challenge.id);
    startChallengeMatch(challenge);
}

function handleDeclineChallenge(ws, data) {
    const challenge = challenges.get(data.challengeId);
    if (!challenge || challenge.toWs !== ws) return sendError(ws, 'That challenge is no longer available.');
    removeChallenge(challenge.id, 'challenge_declined', ws.playerName + ' declined the challenge.');
}

function getRoomForPlayer(ws) {
    if (!isRegistered(ws) || !ws.roomId) return null;
    const room = gameRooms.get(ws.roomId);
    if (!room || (room.white !== ws && room.black !== ws && !room.spectators.includes(ws))) return null;
    return room;
}

function handleMove(ws, data) {
    const room = getRoomForPlayer(ws);
    if (!room || ws.isSpectator || (ws !== room.white && ws !== room.black)) return sendError(ws, 'You cannot move in this room.');
    if (room.gameOver) return sendError(ws, 'This game has already ended.');
    if (typeof data.fen !== 'string' || !data.move || typeof data.move !== 'object') return sendError(ws, 'Invalid move payload.');

    const mover = ws === room.white ? 'white' : 'black';
    const clock = settleClock(room);
    if (!clock || !clock.running) return sendError(ws, 'The game clock is not running.');
    if (clock.activeColor !== mover) return sendError(ws, 'It is not your turn.');
    if ((mover === 'white' ? clock.whiteMs : clock.blackMs) <= 0) {
        finishOnTimeout(room, mover);
        return;
    }

    // Settle and switch before broadcasting a move. If the clock reaches zero
    // at this boundary, timeout wins and the move is not accepted.
    if (!switchClockAfterMove(room, mover)) return;
    room.gameState.fen = data.fen;
    room.gameState.moves.push(data.move);
    const payload = { type: 'move_made', move: data.move, fen: data.fen, clock: clockSnapshot(room) };
    send(room.white, payload);
    send(room.black, payload);
    room.spectators.forEach(function (spectator) { send(spectator, payload); });
}

function handleGameOver(ws, data) {
    const room = getRoomForPlayer(ws);
    if (!room || ws.isSpectator) return sendError(ws, 'You are not an active player in this room.');
    if (room.gameOver) return;
    room.gameOver = true;
    stopClock(room);
    const payload = { type: 'game_over', result: String(data.result || 'Game over'), clock: clockSnapshot(room) };
    send(room.white, payload);
    send(room.black, payload);
    room.spectators.forEach(function (spectator) { send(spectator, payload); });
}

function handleChatMessage(ws, data) {
    const room = getRoomForPlayer(ws);
    if (!room || ws.isSpectator || (ws !== room.white && ws !== room.black)) return sendError(ws, 'Join a game before sending chat messages.');
    const message = typeof data.message === 'string' ? data.message.trim() : '';
    if (!message || message.length > 500) return sendError(ws, 'Chat messages must be 1–500 characters.');
    const payload = {
        type: 'chat_message',
        message: message,
        sender: ws.playerName || 'Player',
        playerId: ws.playerId
    };
    const opponent = ws === room.white ? room.black : room.white;
    send(opponent, payload);
}

function handleOfferDraw(ws, data) {
    const room = getRoomForPlayer(ws);
    if (!room || ws.isSpectator || (ws !== room.white && ws !== room.black)) return sendError(ws, 'You are not an active player in this room.');
    const opponent = ws === room.white ? room.black : room.white;
    if (!opponent) return sendError(ws, 'Your opponent has not joined yet.');
    send(opponent, { type: 'draw_offer', fromColor: ws.color, fromName: ws.playerName });
}

function handleDrawResponse(ws, data) {
    const room = getRoomForPlayer(ws);
    if (!room || ws.isSpectator || (ws !== room.white && ws !== room.black)) return sendError(ws, 'You are not an active player in this room.');
    const opponent = ws === room.white ? room.black : room.white;
    if (!opponent) return sendError(ws, 'Your opponent has not joined yet.');
    send(opponent, { type: 'draw_response', accepted: Boolean(data.accepted) });
    if (data.accepted) {
        const payload = { type: 'game_over', result: 'Draw agreed' };
        send(room.white, payload);
        send(room.black, payload);
        room.spectators.forEach(function (spectator) { send(spectator, payload); });
        room.white.roomId = null;
        room.black.roomId = null;
        gameRooms.delete(ws.roomId);
        broadcastPlayerList();
    }
}

function handlePlayerDisconnect(ws) {
    if (ws.playerId) {
        const player = onlinePlayers.get(ws.playerId);
        if (player && player.ws === ws) onlinePlayers.delete(ws.playerId);
    }

    for (const challenge of Array.from(challenges.values())) {
        if (challenge.fromWs === ws || challenge.toWs === ws) {
            const otherWs = challenge.fromWs === ws ? challenge.toWs : challenge.fromWs;
            removeChallenge(challenge.id, 'challenge_expired', 'A player disconnected.');
            send(otherWs, { type: 'player_left', playerName: ws.playerName || 'A player' });
        }
    }

    const roomId = ws.roomId;
    if (roomId) {
        const room = gameRooms.get(roomId);
        if (room) {
            const payload = { type: 'player_disconnected', color: ws.color };
            if (ws === room.white) {
                room.white = null;
                send(room.black, payload);
            } else if (ws === room.black) {
                room.black = null;
                send(room.white, payload);
            } else {
                room.spectators = room.spectators.filter(function (spectator) { return spectator !== ws; });
            }
            if (!room.white && !room.black && room.spectators.length === 0) gameRooms.delete(roomId);
        }
    }
    broadcastPlayerList();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, function () {
    console.log('Chessify test lobby server listening on port ' + PORT);
});
