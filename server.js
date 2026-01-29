require('dotenv').config();
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');

const PORT = process.env.PORT || 3000;
const PRIZE_AMOUNT = parseFloat(process.env.PRIZE_AMOUNT) || 0.1;
const PAYOUT_PRIVATE_KEY = process.env.PAYOUT_PRIVATE_KEY;

// Solana connection (mainnet)
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

// Load payout wallet
let payoutWallet = null;
if (PAYOUT_PRIVATE_KEY && PAYOUT_PRIVATE_KEY !== 'YOUR_PRIVATE_KEY_HERE') {
    try {
        const secretKey = bs58.decode(PAYOUT_PRIVATE_KEY);
        payoutWallet = Keypair.fromSecretKey(secretKey);
        console.log(`Payout wallet loaded: ${payoutWallet.publicKey.toString()}`);
    } catch (e) {
        console.error('Failed to load payout wallet:', e.message);
    }
}

// Payout queue
let payoutQueue = [];
let processingPayout = false;

// Process payout
async function processPayout(payout) {
    if (!payoutWallet) {
        console.log('[PAYOUT] No wallet configured - skipping');
        return false;
    }
    
    try {
        const recipientPubkey = new PublicKey(payout.wallet);
        const lamports = Math.floor(payout.amount * LAMPORTS_PER_SOL);
        
        // Check balance
        const balance = await connection.getBalance(payoutWallet.publicKey);
        if (balance < lamports + 5000) { // + fee buffer
            console.log(`[PAYOUT] Insufficient balance: ${balance / LAMPORTS_PER_SOL} SOL`);
            return false;
        }
        
        // Create transaction
        const transaction = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: payoutWallet.publicKey,
                toPubkey: recipientPubkey,
                lamports: lamports
            })
        );
        
        // Get recent blockhash
        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = payoutWallet.publicKey;
        
        // Sign and send
        transaction.sign(payoutWallet);
        const signature = await connection.sendRawTransaction(transaction.serialize());
        
        // Confirm
        await connection.confirmTransaction(signature);
        
        console.log(`[PAYOUT SUCCESS] ${payout.amount} SOL to ${payout.wallet.slice(0,4)}...${payout.wallet.slice(-4)}`);
        console.log(`[TX] https://solscan.io/tx/${signature}`);
        
        return true;
    } catch (e) {
        console.error('[PAYOUT ERROR]', e.message);
        return false;
    }
}

// Process payout queue
async function processPayoutQueue() {
    if (processingPayout || payoutQueue.length === 0) return;
    
    processingPayout = true;
    const payout = payoutQueue.shift();
    
    const success = await processPayout(payout);
    if (!success) {
        // Re-queue failed payouts (max 3 retries)
        payout.retries = (payout.retries || 0) + 1;
        if (payout.retries < 3) {
            payoutQueue.push(payout);
        } else {
            console.log(`[PAYOUT] Giving up on payout to ${payout.wallet} after 3 retries`);
        }
    }
    
    processingPayout = false;
}

// Process payouts every 10 seconds
setInterval(processPayoutQueue, 10000);
const WORLD_WIDTH = 4000;
const WORLD_HEIGHT = 3000;
const TICK_RATE = 60;
const ROUND_TIME = 300;
const MIN_PLAYERS = 8;

// Game state
let players = new Map();
let food = [];
let gameRunning = true;
let roundActive = false;
let roundTime = ROUND_TIME;
let roundNum = 1;
let waitingForPlayers = true;

// Generate initial food
function spawnFood(count = 1) {
    for (let i = 0; i < count; i++) {
        food.push({
            id: Math.random().toString(36).substr(2, 9),
            x: Math.random() * WORLD_WIDTH,
            y: Math.random() * WORLD_HEIGHT,
            radius: 4 + Math.random() * 4,
            color: Math.random() < 0.3 ? '#14F195' : '#ffffff'
        });
    }
}

// Initialize food
spawnFood(300);

// Create HTTP server for serving static files
const server = http.createServer((req, res) => {
    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(__dirname, filePath);
    
    const ext = path.extname(filePath);
    const contentTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.png': 'image/png',
        '.jpg': 'image/jpeg'
    };
    
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
        res.end(data);
    });
});

// WebSocket server
const wss = new WebSocket.Server({ server });

// Player class
class Player {
    constructor(id, name, wallet = null) {
        this.id = id;
        this.name = name;
        this.wallet = wallet;
        this.segments = [];
        this.angle = Math.random() * Math.PI * 2;
        this.targetAngle = this.angle;
        this.speed = 4;
        this.alive = true;
        this.boosting = false;
        this.score = 0;
        
        // Spawn at random position
        const startX = Math.random() * WORLD_WIDTH;
        const startY = Math.random() * WORLD_HEIGHT;
        
        for (let i = 0; i < 10; i++) {
            this.segments.push({
                x: startX - i * 10,
                y: startY
            });
        }
    }
    
    get head() {
        return this.segments[0];
    }
    
    get length() {
        return this.segments.length;
    }
    
    update() {
        if (!this.alive) return;
        
        // Smooth turning
        let angleDiff = this.targetAngle - this.angle;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        this.angle += angleDiff * 0.12;
        
        // Speed
        let currentSpeed = this.speed;
        if (this.boosting && this.segments.length > 15) {
            currentSpeed = this.speed * 2;
            // Lose segments while boosting
            if (Math.random() < 0.15) {
                const tail = this.segments.pop();
                if (tail) {
                    food.push({
                        id: Math.random().toString(36).substr(2, 9),
                        x: tail.x,
                        y: tail.y,
                        radius: 4,
                        color: '#14F195'
                    });
                }
            }
        }
        
        // Move
        const newHead = {
            x: this.head.x + Math.cos(this.angle) * currentSpeed,
            y: this.head.y + Math.sin(this.angle) * currentSpeed
        };
        
        // World bounds (wrap)
        if (newHead.x < 0) newHead.x = WORLD_WIDTH;
        if (newHead.x > WORLD_WIDTH) newHead.x = 0;
        if (newHead.y < 0) newHead.y = WORLD_HEIGHT;
        if (newHead.y > WORLD_HEIGHT) newHead.y = 0;
        
        this.segments.unshift(newHead);
        this.segments.pop();
    }
    
    grow(amount = 1) {
        for (let i = 0; i < amount; i++) {
            const tail = this.segments[this.segments.length - 1];
            this.segments.push({ x: tail.x, y: tail.y });
        }
    }
    
    die() {
        this.alive = false;
        // Convert to food
        this.segments.forEach(seg => {
            if (Math.random() < 0.6) {
                food.push({
                    id: Math.random().toString(36).substr(2, 9),
                    x: seg.x + (Math.random() - 0.5) * 20,
                    y: seg.y + (Math.random() - 0.5) * 20,
                    radius: 5,
                    color: Math.random() < 0.5 ? '#14F195' : '#ffffff'
                });
            }
        });
    }
    
    toJSON() {
        return {
            id: this.id,
            name: this.name,
            segments: this.segments,
            angle: this.angle,
            alive: this.alive,
            length: this.length
        };
    }
}

// Handle connections
wss.on('connection', (ws) => {
    let playerId = null;
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            
            switch (msg.type) {
                case 'join':
                    playerId = Math.random().toString(36).substr(2, 9);
                    const player = new Player(playerId, msg.name || 'Anonymous', msg.wallet || null);
                    players.set(playerId, player);
                    
                    ws.send(JSON.stringify({
                        type: 'joined',
                        id: playerId,
                        worldWidth: WORLD_WIDTH,
                        worldHeight: WORLD_HEIGHT
                    }));
                    
                    const walletStatus = player.wallet ? `wallet: ${player.wallet.slice(0,4)}...${player.wallet.slice(-4)}` : 'no wallet';
                    console.log(`Player joined: ${player.name} (${playerId}) [${walletStatus}]`);
                    break;
                    
                case 'input':
                    if (playerId && players.has(playerId)) {
                        const p = players.get(playerId);
                        if (msg.angle !== undefined) p.targetAngle = msg.angle;
                        if (msg.boost !== undefined) p.boosting = msg.boost;
                    }
                    break;
                    
                case 'respawn':
                    if (playerId) {
                        const oldPlayer = players.get(playerId);
                        const newPlayer = new Player(playerId, oldPlayer?.name || 'Anonymous');
                        players.set(playerId, newPlayer);
                    }
                    break;
            }
        } catch (e) {
            console.error('Message error:', e);
        }
    });
    
    ws.on('close', () => {
        if (playerId) {
            const player = players.get(playerId);
            if (player) {
                player.die();
                console.log(`Player left: ${player.name}`);
            }
            players.delete(playerId);
        }
    });
});

// Game loop
function gameTick() {
    // Update all players
    players.forEach(player => player.update());
    
    // Check food collisions
    players.forEach(player => {
        if (!player.alive) return;
        
        for (let i = food.length - 1; i >= 0; i--) {
            const f = food[i];
            const dist = Math.hypot(f.x - player.head.x, f.y - player.head.y);
            if (dist < 15 + f.radius) {
                player.grow(Math.ceil(f.radius / 2));
                player.score += Math.ceil(f.radius);
                food.splice(i, 1);
                spawnFood(1);
            }
        }
    });
    
    // Check snake collisions
    const playersArray = Array.from(players.values());
    playersArray.forEach(player => {
        if (!player.alive) return;
        
        playersArray.forEach(other => {
            if (other.id === player.id || !other.alive) return;
            
            // Check head vs body
            for (let i = 5; i < other.segments.length; i++) {
                const seg = other.segments[i];
                const dist = Math.hypot(seg.x - player.head.x, seg.y - player.head.y);
                if (dist < 18) {
                    player.die();
                    other.score += player.length * 10;
                    other.grow(Math.floor(player.length / 3));
                    console.log(`${player.name} was killed by ${other.name}`);
                    
                    // Broadcast kill event
                    const killMsg = JSON.stringify({
                        type: 'kill',
                        killer: other.name,
                        killerId: other.id,
                        victim: player.name,
                        victimId: player.id
                    });
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(killMsg);
                        }
                    });
                    return;
                }
            }
        });
    });
    
    // Broadcast state
    const alivePlayers = Array.from(players.values()).filter(p => p.alive);
    const state = {
        type: 'state',
        players: Array.from(players.values()).map(p => p.toJSON()),
        food: food,
        roundTime: roundTime,
        roundNum: roundNum,
        waiting: waitingForPlayers,
        minPlayers: MIN_PLAYERS,
        currentPlayers: alivePlayers.length
    };
    
    const stateStr = JSON.stringify(state);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(stateStr);
        }
    });
}

// Round timer
setInterval(() => {
    const alivePlayers = Array.from(players.values()).filter(p => p.alive);
    const playerCount = alivePlayers.length;
    
    // Check if we have enough players
    if (playerCount < MIN_PLAYERS) {
        waitingForPlayers = true;
        roundActive = false;
        roundTime = ROUND_TIME; // Reset timer while waiting
        return;
    }
    
    // Start round if we just got enough players
    if (waitingForPlayers && playerCount >= MIN_PLAYERS) {
        waitingForPlayers = false;
        roundActive = true;
        roundTime = ROUND_TIME;
        console.log(`[ROUND ${roundNum}] Starting with ${playerCount} players!`);
        
        // Broadcast round start
        const startMsg = JSON.stringify({
            type: 'roundStart',
            round: roundNum,
            players: playerCount
        });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(startMsg);
            }
        });
    }
    
    if (!roundActive) return;
    
    if (roundTime > 0) {
        roundTime--;
    } else {
        // Round end - find winner
        let winner = null;
        let maxLength = 0;
        players.forEach(p => {
            if (p.alive && p.length > maxLength) {
                maxLength = p.length;
                winner = p;
            }
        });
        
        // Broadcast round end to all clients
        const roundEndMsg = JSON.stringify({
            type: 'roundEnd',
            round: roundNum,
            winner: winner ? winner.name : null,
            winnerId: winner ? winner.id : null,
            winnerLength: winner ? winner.length : 0,
            prize: '0.1 SOL'
        });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(roundEndMsg);
            }
        });
        
        if (winner) {
            console.log(`[ROUND ${roundNum}] Winner: ${winner.name} (${winner.length}) - Prize: ${PRIZE_AMOUNT} SOL`);
            
            // Queue payout if winner has wallet
            if (winner.wallet) {
                payoutQueue.push({
                    wallet: winner.wallet,
                    amount: PRIZE_AMOUNT,
                    player: winner.name,
                    round: roundNum,
                    timestamp: Date.now()
                });
                console.log(`[PAYOUT QUEUED] ${PRIZE_AMOUNT} SOL to ${winner.wallet.slice(0,4)}...${winner.wallet.slice(-4)}`);
            } else {
                console.log(`[PAYOUT SKIPPED] ${winner.name} has no wallet connected`);
            }
        }
        
        // Reset round
        roundNum++;
        roundTime = ROUND_TIME;
        
        // Reset all players for new round
        players.forEach((player, id) => {
            const newPlayer = new Player(id, player.name);
            players.set(id, newPlayer);
        });
        
        // Reset food
        food = [];
        spawnFood(300);
        
        console.log(`[ROUND ${roundNum}] Starting...`);
    }
}, 1000);

// Start game loop
setInterval(gameTick, 1000 / TICK_RATE);

// API endpoint to check payout queue (for admin)
const originalHandler = server.listeners('request')[0];
server.removeListener('request', originalHandler);

server.on('request', (req, res) => {
    if (req.url === '/api/payouts' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            pending: payoutQueue,
            total: payoutQueue.reduce((sum, p) => sum + p.amount, 0)
        }));
        return;
    }
    
    if (req.url === '/api/payouts/clear' && req.method === 'POST') {
        const cleared = payoutQueue.length;
        payoutQueue = [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cleared }));
        return;
    }
    
    if (req.url === '/api/stats' && req.method === 'GET') {
        const alivePlayers = Array.from(players.values()).filter(p => p.alive);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            players: players.size,
            alive: alivePlayers.length,
            round: roundNum,
            timeLeft: roundTime,
            prizePool: PRIZE_AMOUNT
        }));
        return;
    }
    
    originalHandler(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`$PUMPSNEK server running on port ${PORT}`);
    console.log(`Prize per round: ${PRIZE_AMOUNT} SOL`);
    console.log(`Round duration: ${ROUND_TIME}s`);
});
