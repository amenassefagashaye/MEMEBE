#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env

/**
 * Assefa Digital Bingo Game Server
 * Deno Deploy Compatible Version
 */

// ================ IMPORTS ================
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

// ================ TYPES ================
interface Client {
    socket: WebSocket;
    userId: string;
    name: string;
    room: string;
    role: 'player' | 'admin' | 'spectator';
    joinedAt: number;
    ip: string;
}

interface WebSocketMessage {
    type: string;
    [key: string]: any;
}

interface Room {
    clients: Set<string>;
    name: string;
    createdAt: number;
}

// ================ CONFIGURATION ================
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") || "we17me78";
const PORT = parseInt(Deno.env.get("PORT") || "8000");
const SERVER_START_TIME = Date.now();

// ================ GLOBAL STATE ================
const clients = new Map<string, Client>();
const rooms = new Map<string, Room>();
const clientRooms = new Map<string, string>();

// ================ UTILITY FUNCTIONS ================
function generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function sanitizeInput(input: string): string {
    if (!input) return '';
    return input
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

function validatePassword(input: string | null): boolean {
    if (!input) return false;
    return input === ADMIN_PASSWORD;
}

function getUptime(): number {
    return Math.floor((Date.now() - SERVER_START_TIME) / 1000);
}

function getClientIp(req: Request): string {
    const forwardedFor = req.headers.get("x-forwarded-for");
    if (forwardedFor) {
        const ips = forwardedFor.split(",");
        return ips[0]?.trim() || "unknown";
    }
    return req.headers.get("x-real-ip") || "unknown";
}

// ================ WEB SOCKET HANDLER ================
async function handleWebSocket(req: Request): Promise<Response> {
    // Create WebSocket
    const { socket, response } = Deno.upgradeWebSocket(req);
    
    const url = new URL(req.url);
    const params = url.searchParams;
    
    const clientId = generateClientId();
    const name = sanitizeInput(params.get("name") || "Anonymous");
    const room = sanitizeInput(params.get("room") || "bingo_main");
    const role = (sanitizeInput(params.get("role") || "player") as 'player' | 'admin' | 'spectator');
    const ip = getClientIp(req);
    
    // Create client object
    const client: Client = {
        socket,
        userId: clientId,
        name,
        room,
        role,
        joinedAt: Date.now(),
        ip
    };
    
    // Store client
    clients.set(clientId, client);
    
    // Add to room
    if (!rooms.has(room)) {
        rooms.set(room, {
            clients: new Set(),
            name: room,
            createdAt: Date.now()
        });
    }
    rooms.get(room)!.clients.add(clientId);
    clientRooms.set(clientId, room);
    
    // WebSocket event handlers
    socket.onopen = () => {
        console.log(`Client connected: ${clientId} (${name})`);
        
        // Send welcome message
        socket.send(JSON.stringify({
            type: "welcome",
            message: `Welcome to ${room}!`,
            userId: clientId,
            timestamp: Date.now()
        }));
        
        // Notify room about new user
        broadcastToRoom(room, clientId, {
            type: "user-joined",
            userId: clientId,
            name: name,
            timestamp: Date.now(),
            users: getRoomUsers(room)
        });
    };
    
    socket.onmessage = (event) => {
        try {
            const message: WebSocketMessage = JSON.parse(event.data);
            handleWebSocketMessage(clientId, message);
        } catch (error) {
            console.error("Error parsing message:", error);
            socket.send(JSON.stringify({
                type: "error",
                message: "Invalid message format"
            }));
        }
    };
    
    socket.onclose = () => {
        console.log(`Client disconnected: ${clientId}`);
        handleClientDisconnect(clientId);
    };
    
    socket.onerror = (error) => {
        console.error(`WebSocket error for ${clientId}:`, error);
    };
    
    return response;
}

function handleWebSocketMessage(clientId: string, message: WebSocketMessage) {
    const client = clients.get(clientId);
    if (!client) return;
    
    switch (message.type) {
        case "ping":
            client.socket.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
            break;
            
        case "bingo-number":
            handleBingoNumber(client, message);
            break;
            
        case "winner":
            handleWinner(client, message);
            break;
            
        case "offer":
        case "answer":
        case "ice-candidate":
            handleRTCSignaling(client, message);
            break;
            
        case "chat":
            handleChatMessage(client, message);
            break;
            
        case "get-users":
            sendRoomUsers(client);
            break;
            
        default:
            console.log(`Unknown message type: ${message.type}`);
    }
}

function handleBingoNumber(client: Client, message: WebSocketMessage) {
    const number = message.number;
    if (typeof number !== 'number' || number < 1 || number > 90) {
        client.socket.send(JSON.stringify({
            type: "error",
            message: "Invalid bingo number (1-90)"
        }));
        return;
    }
    
    // Broadcast to room
    broadcastToRoom(client.room, client.userId, {
        type: "bingo-number",
        number: number,
        calledBy: client.name,
        timestamp: Date.now()
    });
}

function handleWinner(client: Client, message: WebSocketMessage) {
    broadcastToRoom(client.room, null, {
        type: "winner",
        userId: client.userId,
        userName: client.name,
        timestamp: Date.now(),
        winAmount: message.winAmount || 0
    });
}

function handleRTCSignaling(client: Client, message: WebSocketMessage) {
    const target = message.target;
    
    if (target === 'broadcast') {
        broadcastToRoom(client.room, client.userId, {
            ...message,
            from: client.userId
        });
    } else if (target) {
        const targetClient = clients.get(target);
        if (targetClient && targetClient.room === client.room) {
            targetClient.socket.send(JSON.stringify({
                ...message,
                from: client.userId
            }));
        }
    }
}

function handleChatMessage(client: Client, message: WebSocketMessage) {
    const chatMessage = sanitizeInput(message.message || "");
    
    if (chatMessage.length > 500) {
        client.socket.send(JSON.stringify({
            type: "error",
            message: "Message too long"
        }));
        return;
    }
    
    broadcastToRoom(client.room, null, {
        type: "chat",
        userId: client.userId,
        userName: client.name,
        message: chatMessage,
        timestamp: Date.now()
    });
}

function sendRoomUsers(client: Client) {
    const roomUsers = getRoomUsers(client.room);
    client.socket.send(JSON.stringify({
        type: "users",
        users: roomUsers,
        timestamp: Date.now()
    }));
}

function handleClientDisconnect(clientId: string) {
    const client = clients.get(clientId);
    if (!client) return;
    
    const room = client.room;
    
    // Remove from room
    const roomObj = rooms.get(room);
    if (roomObj) {
        roomObj.clients.delete(clientId);
        if (roomObj.clients.size === 0) {
            rooms.delete(room);
        }
    }
    
    // Remove client
    clients.delete(clientId);
    clientRooms.delete(clientId);
    
    // Notify room
    broadcastToRoom(room, null, {
        type: "user-left",
        userId: clientId,
        name: client.name,
        timestamp: Date.now(),
        users: getRoomUsers(room)
    });
}

function broadcastToRoom(room: string, excludeClientId: string | null, message: any) {
    const roomObj = rooms.get(room);
    if (!roomObj) return;
    
    const messageStr = JSON.stringify(message);
    
    for (const clientId of roomObj.clients) {
        if (clientId === excludeClientId) continue;
        
        const client = clients.get(clientId);
        if (client && client.socket.readyState === WebSocket.OPEN) {
            try {
                client.socket.send(messageStr);
            } catch (error) {
                console.error(`Error sending to ${clientId}:`, error);
            }
        }
    }
}

function getRoomUsers(room: string): Array<{userId: string; name: string; role: string; joinedAt: number}> {
    const roomObj = rooms.get(room);
    if (!roomObj) return [];
    
    const users = [];
    for (const clientId of roomObj.clients) {
        const client = clients.get(clientId);
        if (client) {
            users.push({
                userId: client.userId,
                name: client.name,
                role: client.role,
                joinedAt: client.joinedAt
            });
        }
    }
    return users;
}

// ================ HTTP REQUEST HANDLER ================
async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    
    // CORS headers
    const headers = new Headers({
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Content-Type"
    });
    
    // Handle preflight requests
    if (req.method === "OPTIONS") {
        return new Response(null, { headers });
    }
    
    // Handle WebSocket upgrade
    if (path === "/ws") {
        if (req.headers.get("upgrade") === "websocket") {
            return handleWebSocket(req);
        }
        return new Response("Expected WebSocket", { status: 400 });
    }
    
    // Handle admin page
    if (path === "/admin.html" || path === "/admin") {
        return handleAdminRequest(req);
    }
    
    // Handle health check
    if (path === "/health") {
        return new Response(JSON.stringify({
            status: "ok",
            timestamp: Date.now(),
            clients: clients.size,
            rooms: rooms.size,
            uptime: getUptime(),
            version: "1.0.0"
        }), {
            headers: { ...headers, "content-type": "application/json" }
        });
    }
    
    // Handle stats
    if (path === "/stats") {
        const stats = {
            totalClients: clients.size,
            totalRooms: rooms.size,
            uptime: getUptime(),
            serverStartTime: SERVER_START_TIME,
            memoryUsage: {
                clients: clients.size,
                rooms: rooms.size
            }
        };
        
        return new Response(JSON.stringify(stats), {
            headers: { ...headers, "content-type": "application/json" }
        });
    }
    
    // Serve static files
    if (path === "/" || path === "/index.html") {
        return serveStaticFile("index.html", headers);
    }
    
    // Serve other static files from memory
    return serveStaticFile(path, headers);
}

function handleAdminRequest(req: Request): Response {
    const url = new URL(req.url);
    const password = url.searchParams.get("password");
    
    if (!validatePassword(password)) {
        return new Response(
            `<html><body style="font-family: Arial; text-align: center; padding: 50px; background: #0d47a1; color: white;">
                <h1 style="color: #dc3545;">Access Denied</h1>
                <p>Invalid admin password.</p>
                <p><a href="/" style="color: #ffd700;">Return to Game</a></p>
            </body></html>`,
            { headers: { "content-type": "text/html" }, status: 403 }
        );
    }
    
    // Serve admin page from memory
    return serveAdminPage(headers);
}

function serveStaticFile(path: string, headers: Headers): Response {
    // Remove leading slash
    const filePath = path.startsWith("/") ? path.substring(1) : path;
    
    // Default to index.html if empty
    const finalPath = filePath === "" ? "index.html" : filePath;
    
    // In-memory static files
    const staticFiles: Record<string, { content: string; type: string }> = {
        "index.html": {
            content: `<!DOCTYPE html>
<html>
<head>
    <title>Redirecting...</title>
    <script>
        window.location.href = "/game.html";
    </script>
</head>
<body>
    <p>Redirecting to game...</p>
</body>
</html>`,
            type: "text/html"
        },
        "game.html": {
            content: `<!DOCTYPE html>
<html>
<head>
    <title>Game Not Available</title>
    <style>
        body { font-family: Arial; text-align: center; padding: 50px; background: #0d47a1; color: white; }
        h1 { color: #ffd700; }
        a { color: #28a745; text-decoration: none; font-weight: bold; }
    </style>
</head>
<body>
    <h1>Game HTML Not Found</h1>
    <p>The game HTML file needs to be loaded separately.</p>
    <p>Make sure to upload the frontend/index.html file to your deployment.</p>
</body>
</html>`,
            type: "text/html"
        }
    };
    
    const file = staticFiles[finalPath];
    if (file) {
        headers.set("content-type", file.type);
        return new Response(file.content, { headers });
    }
    
    // Return 404 for unknown files
    return new Response(
        `<html><body style="font-family: Arial; text-align: center; padding: 50px; background: #0d47a1; color: white;">
            <h1 style="color: #ffd700;">404 - Not Found</h1>
            <p>File not found: ${path}</p>
            <p><a href="/" style="color: #28a745;">Return Home</a></p>
        </body></html>`,
        { headers: { "content-type": "text/html" }, status: 404 }
    );
}

function serveAdminPage(headers: Headers): Response {
    const adminHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Panel - Bingo Game</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, sans-serif; background: #0d47a1; color: white; min-height: 100vh; padding: 20px; }
        .admin-container { max-width: 800px; margin: 0 auto; }
        .admin-header { text-align: center; padding: 20px; background: rgba(0,0,0,0.3); border-radius: 10px; margin-bottom: 20px; border: 3px solid #ffd700; }
        .admin-title { font-size: 28px; color: #ffd700; margin-bottom: 10px; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: rgba(0,0,0,0.4); padding: 20px; border-radius: 10px; border: 2px solid #28a745; text-align: center; }
        .stat-value { font-size: 36px; font-weight: bold; color: #ffd700; margin: 10px 0; }
        .stat-label { color: #ccc; font-size: 14px; }
        .admin-sections { display: grid; grid-template-columns: 1fr; gap: 20px; }
        .section { background: rgba(0,0,0,0.4); border-radius: 10px; padding: 20px; border: 2px solid #17a2b8; }
        .section-title { color: #ffd700; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #444; }
        .btn { padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; transition: all 0.3s; margin: 5px; }
        .btn-primary { background: #28a745; color: white; }
        .btn-danger { background: #dc3545; color: white; }
        .btn-warning { background: #ffc107; color: #333; }
        .btn:hover { transform: translateY(-2px); box-shadow: 0 5px 15px rgba(0,0,0,0.3); }
        .log-container { background: rgba(0,0,0,0.8); border-radius: 5px; padding: 15px; font-family: monospace; font-size: 12px; max-height: 200px; overflow-y: auto; margin-top: 10px; }
        .connection-status { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; }
        .connected { background: #28a745; animation: pulse 2s infinite; }
        .disconnected { background: #dc3545; }
        @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
    </style>
</head>
<body>
    <div class="admin-container">
        <div class="admin-header">
            <h1 class="admin-title">Bingo Game Admin Panel</h1>
            <p>Server Status: <span id="serverStatus">Online</span></p>
            <div>
                <button class="btn btn-primary" id="refreshBtn">Refresh Stats</button>
                <button class="btn btn-warning" id="callNumberBtn">Call Random Number</button>
                <button class="btn btn-danger" id="broadcastBtn">Broadcast Reset</button>
            </div>
        </div>
        
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">Connected Players</div>
                <div class="stat-value" id="playerCount">0</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Active Rooms</div>
                <div class="stat-value" id="roomCount">0</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Server Uptime</div>
                <div class="stat-value" id="uptime">0s</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">WebSocket Status</div>
                <div class="stat-value">
                    <span class="connection-status" id="wsStatus"></span>
                    <span id="wsStatusText">Disconnected</span>
                </div>
            </div>
        </div>
        
        <div class="admin-sections">
            <div class="section">
                <h2 class="section-title">Game Control</h2>
                <div>
                    <input type="number" id="manualNumber" min="1" max="90" placeholder="Enter number (1-90)" style="padding: 10px; width: 150px;">
                    <button class="btn btn-primary" id="callManualBtn">Call Number</button>
                </div>
                <div style="margin-top: 15px;">
                    <input type="text" id="broadcastMsg" placeholder="Message to all players" style="padding: 10px; width: 300px;">
                    <button class="btn btn-warning" id="sendMsgBtn">Send Message</button>
                </div>
            </div>
            
            <div class="section">
                <h2 class="section-title">Server Logs</h2>
                <div class="log-container" id="serverLogs">
                    <div>Admin panel initialized...</div>
                </div>
                <button class="btn btn-danger" id="clearLogsBtn" style="margin-top: 10px;">Clear Logs</button>
            </div>
        </div>
    </div>
    
    <script>
        class AdminPanel {
            constructor() {
                this.ws = null;
                this.logs = [];
                this.init();
            }
            
            init() {
                this.connectWebSocket();
                this.loadStats();
                this.setupEventListeners();
                
                setInterval(() => this.loadStats(), 5000);
                setInterval(() => this.updateUptime(), 1000);
            }
            
            connectWebSocket() {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const wsUrl = \`\${protocol}//\${window.location.host}/ws?role=admin&name=Admin\`;
                
                this.ws = new WebSocket(wsUrl);
                
                this.ws.onopen = () => {
                    this.addLog('WebSocket connected', 'success');
                    this.updateWsStatus(true);
                };
                
                this.ws.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    this.handleMessage(data);
                };
                
                this.ws.onclose = () => {
                    this.addLog('WebSocket disconnected', 'warning');
                    this.updateWsStatus(false);
                    setTimeout(() => this.connectWebSocket(), 3000);
                };
                
                this.ws.onerror = (error) => {
                    this.addLog('WebSocket error', 'error');
                };
            }
            
            handleMessage(data) {
                switch(data.type) {
                    case 'welcome':
                        this.addLog('Connected as admin', 'success');
                        break;
                    case 'bingo-number':
                        this.addLog(\`Number called: \${data.number} by \${data.calledBy}\`, 'info');
                        break;
                    case 'winner':
                        this.addLog(\`Winner: \${data.userName}\`, 'success');
                        break;
                    case 'user-joined':
                        this.addLog(\`User joined: \${data.name}\`, 'info');
                        break;
                    case 'user-left':
                        this.addLog(\`User left: \${data.name}\`, 'warning');
                        break;
                }
            }
            
            async loadStats() {
                try {
                    const response = await fetch('/stats');
                    const data = await response.json();
                    
                    document.getElementById('playerCount').textContent = data.totalClients;
                    document.getElementById('roomCount').textContent = data.totalRooms;
                    document.getElementById('uptime').textContent = data.uptime + 's';
                } catch (error) {
                    console.error('Error loading stats:', error);
                }
            }
            
            updateUptime() {
                const uptimeElem = document.getElementById('uptime');
                if (uptimeElem) {
                    const current = parseInt(uptimeElem.textContent) || 0;
                    uptimeElem.textContent = (current + 1) + 's';
                }
            }
            
            updateWsStatus(connected) {
                const statusElem = document.getElementById('wsStatus');
                const textElem = document.getElementById('wsStatusText');
                
                if (connected) {
                    statusElem.className = 'connection-status connected';
                    textElem.textContent = 'Connected';
                } else {
                    statusElem.className = 'connection-status disconnected';
                    textElem.textContent = 'Disconnected';
                }
            }
            
            setupEventListeners() {
                document.getElementById('refreshBtn').addEventListener('click', () => {
                    this.loadStats();
                });
                
                document.getElementById('callNumberBtn').addEventListener('click', () => {
                    this.callRandomNumber();
                });
                
                document.getElementById('callManualBtn').addEventListener('click', () => {
                    this.callManualNumber();
                });
                
                document.getElementById('sendMsgBtn').addEventListener('click', () => {
                    this.sendBroadcast();
                });
                
                document.getElementById('broadcastBtn').addEventListener('click', () => {
                    this.broadcastReset();
                });
                
                document.getElementById('clearLogsBtn').addEventListener('click', () => {
                    this.clearLogs();
                });
            }
            
            callRandomNumber() {
                const number = Math.floor(Math.random() * 90) + 1;
                this.callNumber(number);
            }
            
            callManualNumber() {
                const input = document.getElementById('manualNumber');
                const number = parseInt(input.value);
                
                if (number >= 1 && number <= 90) {
                    this.callNumber(number);
                    input.value = '';
                } else {
                    this.addLog('Invalid number (1-90 only)', 'error');
                }
            }
            
            callNumber(number) {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({
                        type: 'bingo-number',
                        number: number,
                        admin: true
                    }));
                    this.addLog(\`Called number: \${number}\`, 'info');
                }
            }
            
            sendBroadcast() {
                const input = document.getElementById('broadcastMsg');
                const message = input.value.trim();
                
                if (message && this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({
                        type: 'chat',
                        message: \`[ADMIN] \${message}\`
                    }));
                    
                    this.addLog(\`Broadcast: \${message}\`, 'info');
                    input.value = '';
                }
            }
            
            broadcastReset() {
                if (confirm('Reset game for all players?')) {
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({
                            type: 'chat',
                            message: '[ADMIN] Game reset by administrator'
                        }));
                        
                        this.addLog('Game reset broadcast', 'warning');
                    }
                }
            }
            
            addLog(message, type = 'info') {
                const timestamp = new Date().toLocaleTimeString();
                const logEntry = document.createElement('div');
                logEntry.innerHTML = \`[\${timestamp}] \${message}\`;
                logEntry.style.color = type === 'error' ? '#dc3545' : 
                                      type === 'warning' ? '#ffc107' : 
                                      type === 'success' ? '#28a745' : '#17a2b8';
                
                const container = document.getElementById('serverLogs');
                container.appendChild(logEntry);
                container.scrollTop = container.scrollHeight;
                
                this.logs.push({ timestamp, message, type });
                if (this.logs.length > 100) this.logs.shift();
            }
            
            clearLogs() {
                document.getElementById('serverLogs').innerHTML = '';
                this.logs = [];
                this.addLog('Logs cleared', 'info');
            }
        }
        
        document.addEventListener('DOMContentLoaded', () => {
            window.adminPanel = new AdminPanel();
        });
    </script>
</body>
</html>`;
    
    headers.set("content-type", "text/html");
    return new Response(adminHtml, { headers });
}

// ================ MAIN SERVER ================
async function main() {
    console.log(`🚀 Bingo Game Server starting...`);
    console.log(`🔐 Admin password: ${ADMIN_PASSWORD}`);
    console.log(`🔗 Admin URL: /admin.html?password=${ADMIN_PASSWORD}`);
    console.log(`📡 WebSocket: /ws`);
    console.log(`🏥 Health: /health`);
    console.log(`📊 Stats: /stats`);
    
    // Start server
    serve(handleRequest, { port: PORT });
}

// Start the server
if (import.meta.main) {
    main().catch(console.error);
}

// Export for Deno Deploy
export { handleRequest };
