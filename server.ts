#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env

/**
 * Assefa Digital Bingo Game Server
 * Complete WebSocket server with admin protection
 */

// ================ IMPORTS ================
import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { acceptable, acceptWebSocket } from "https://deno.land/std@0.203.0/ws/mod.ts";

// ================ TYPES ================
interface Client {
    socket: WebSocket;
    userId: string;
    name: string;
    room: string;
    role: 'player' | 'admin' | 'spectator';
    joinedAt: Date;
    ip: string;
}

interface WebSocketMessage {
    type: string;
    [key: string]: any;
}

interface Room {
    clients: Set<string>; // client IDs
    name: string;
    createdAt: Date;
}

// ================ CONFIGURATION ================
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") || "we17me78";
const PORT = parseInt(Deno.env.get("PORT") || "8000");
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") || "http://localhost:8000").split(",");

// ================ GLOBAL STATE ================
const clients = new Map<string, Client>();
const rooms = new Map<string, Room>();
const clientRooms = new Map<string, string>(); // clientId -> roomId
const rateLimits = new Map<string, { count: number; resetTime: number }>();

// ================ UTILITY FUNCTIONS ================
function generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function sanitizeInput(input: string): string {
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

function isRateLimited(ip: string): boolean {
    const now = Date.now();
    const limit = rateLimits.get(ip);
    
    if (!limit) {
        rateLimits.set(ip, { count: 1, resetTime: now + 60000 });
        return false;
    }
    
    if (now > limit.resetTime) {
        rateLimits.set(ip, { count: 1, resetTime: now + 60000 });
        return false;
    }
    
    if (limit.count >= 100) { // 100 requests per minute
        return true;
    }
    
    limit.count++;
    return false;
}

function getClientIp(req: Request): string {
    return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || 
           req.headers.get("x-real-ip") || 
           "unknown";
}

// ================ WEB SOCKET HANDLER ================
async function handleWebSocket(req: Request, clientId: string): Promise<Response> {
    const { socket, response } = Deno.upgradeWebSocket(req);
    
    // Get client info from URL
    const url = new URL(req.url);
    const params = url.searchParams;
    
    const name = sanitizeInput(params.get("name") || "Anonymous");
    const room = sanitizeInput(params.get("room") || "bingo_main");
    const role = (sanitizeInput(params.get("role") || "player")) as 'player' | 'admin' | 'spectator';
    const ip = getClientIp(req);
    
    // Create client object
    const client: Client = {
        socket,
        userId: clientId,
        name,
        room,
        role,
        joinedAt: new Date(),
        ip
    };
    
    // Store client
    clients.set(clientId, client);
    
    // Add to room
    if (!rooms.has(room)) {
        rooms.set(room, {
            clients: new Set(),
            name: room,
            createdAt: new Date()
        });
    }
    rooms.get(room)!.clients.add(clientId);
    clientRooms.set(clientId, room);
    
    // Set up WebSocket event handlers
    socket.onopen = () => {
        console.log(`Client connected: ${clientId} (${name})`);
        
        // Send welcome message
        socket.send(JSON.stringify({
            type: "welcome",
            message: `Welcome to ${room}!`,
            userId: clientId,
            timestamp: new Date().toISOString()
        }));
        
        // Notify room about new user
        broadcastToRoom(room, clientId, {
            type: "user-joined",
            userId: clientId,
            name: name,
            timestamp: new Date().toISOString(),
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
    
    console.log(`Message from ${clientId}:`, message.type);
    
    switch (message.type) {
        case "ping":
            client.socket.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
            break;
            
        case "join":
            // Already handled in connection
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
            message: "Invalid bingo number"
        }));
        return;
    }
    
    // Broadcast to room
    broadcastToRoom(client.room, client.userId, {
        type: "bingo-number",
        number: number,
        calledBy: client.name,
        timestamp: new Date().toISOString()
    });
    
    console.log(`Bingo number called by ${client.name}: ${number}`);
}

function handleWinner(client: Client, message: WebSocketMessage) {
    // Broadcast winner announcement
    broadcastToRoom(client.room, null, {
        type: "winner",
        userId: client.userId,
        userName: client.name,
        timestamp: new Date().toISOString(),
        winAmount: message.winAmount || 0
    });
    
    console.log(`Winner announced: ${client.name}`);
}

function handleRTCSignaling(client: Client, message: WebSocketMessage) {
    const target = message.target;
    
    if (target === 'broadcast') {
        // Broadcast to all in room except sender
        broadcastToRoom(client.room, client.userId, {
            ...message,
            from: client.userId
        });
    } else if (target) {
        // Send to specific client
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
        timestamp: new Date().toISOString()
    });
}

function sendRoomUsers(client: Client) {
    const roomUsers = getRoomUsers(client.room);
    client.socket.send(JSON.stringify({
        type: "users",
        users: roomUsers,
        timestamp: new Date().toISOString()
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
        timestamp: new Date().toISOString(),
        users: getRoomUsers(room)
    });
}

function broadcastToRoom(room: string, excludeClientId: string | null, message: any) {
    const roomObj = rooms.get(room);
    if (!roomObj) return;
    
    for (const clientId of roomObj.clients) {
        if (clientId === excludeClientId) continue;
        
        const client = clients.get(clientId);
        if (client && client.socket.readyState === WebSocket.OPEN) {
            try {
                client.socket.send(JSON.stringify(message));
            } catch (error) {
                console.error(`Error sending to ${clientId}:`, error);
            }
        }
    }
}

function getRoomUsers(room: string): Array<{userId: string; name: string; role: string; joinedAt: Date}> {
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
    const clientIp = getClientIp(req);
    
    // Rate limiting
    if (isRateLimited(clientIp)) {
        return new Response("Too many requests", { status: 429 });
    }
    
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
            const clientId = generateClientId();
            return await handleWebSocket(req, clientId);
        }
        return new Response("Expected WebSocket upgrade", { status: 400 });
    }
    
    // Handle admin page
    if (path === "/admin.html" || path === "/admin") {
        return await handleAdminRequest(req);
    }
    
    // Handle health check
    if (path === "/health") {
        return new Response(JSON.stringify({
            status: "ok",
            timestamp: new Date().toISOString(),
            clients: clients.size,
            rooms: rooms.size,
            uptime: process.uptime()
        }), {
            headers: { ...headers, "content-type": "application/json" }
        });
    }
    
    // Handle stats
    if (path === "/stats") {
        const stats = {
            totalClients: clients.size,
            totalRooms: rooms.size,
            rooms: Array.from(rooms.values()).map(room => ({
                name: room.name,
                clientCount: room.clients.size,
                createdAt: room.createdAt
            })),
            uptime: process.uptime()
        };
        
        return new Response(JSON.stringify(stats), {
            headers: { ...headers, "content-type": "application/json" }
        });
    }
    
    // Serve static files
    if (path === "/" || path === "/index.html") {
        return await serveStaticFile("frontend/index.html", headers);
    }
    
    // Serve other static files
    return await serveStaticFile(path, headers);
}

async function handleAdminRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const password = url.searchParams.get("password");
    
    if (!validatePassword(password)) {
        return new Response(
            `<!DOCTYPE html>
            <html>
            <head>
                <title>Access Denied</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #0d47a1; color: white; }
                    h1 { color: #dc3545; }
                    a { color: #ffd700; text-decoration: none; font-weight: bold; }
                </style>
            </head>
            <body>
                <h1>Access Denied</h1>
                <p>Invalid admin password.</p>
                <p><a href="/">Return to Game</a></p>
            </body>
            </html>`,
            { headers: { "content-type": "text/html" }, status: 403 }
        );
    }
    
    // Serve admin page
    return await serveStaticFile("frontend/admin.html", new Headers({
        "content-type": "text/html"
    }));
}

async function serveStaticFile(path: string, headers: Headers): Promise<Response> {
    try {
        // Remove leading slash
        const filePath = path.startsWith("/") ? path.substring(1) : path;
        
        // Default to index.html if empty
        const finalPath = filePath === "" ? "frontend/index.html" : filePath;
        
        // Try to read file
        const file = await Deno.open(finalPath, { read: true });
        const fileInfo = await Deno.stat(finalPath);
        
        // Determine content type
        let contentType = "text/plain";
        if (finalPath.endsWith(".html")) contentType = "text/html";
        else if (finalPath.endsWith(".js")) contentType = "application/javascript";
        else if (finalPath.endsWith(".css")) contentType = "text/css";
        else if (finalPath.endsWith(".png")) contentType = "image/png";
        else if (finalPath.endsWith(".jpg") || finalPath.endsWith(".jpeg")) contentType = "image/jpeg";
        else if (finalPath.endsWith(".mp3")) contentType = "audio/mpeg";
        else if (finalPath.endsWith(".json")) contentType = "application/json";
        
        headers.set("content-type", contentType);
        headers.set("content-length", fileInfo.size.toString());
        
        return new Response(file.readable, { headers });
    } catch (error) {
        console.error(`Error serving file ${path}:`, error);
        
        if (path.includes("admin")) {
            return new Response("Admin page not found", { status: 404 });
        }
        
        return new Response(
            `<!DOCTYPE html>
            <html>
            <head>
                <title>404 Not Found</title>
                <style>
                    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #0d47a1; color: white; }
                    h1 { color: #ffd700; }
                    a { color: #28a745; text-decoration: none; font-weight: bold; }
                </style>
            </head>
            <body>
                <h1>404 - Page Not Found</h1>
                <p>The requested page could not be found.</p>
                <p><a href="/">Return to Game</a></p>
            </body>
            </html>`,
            { headers: { "content-type": "text/html" }, status: 404 }
        );
    }
}

// ================ ADMIN HTML ================
async function generateAdminHtml(): Promise<void> {
    const adminHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Panel - Bingo Game</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: Arial, sans-serif; background: linear-gradient(135deg, #1a237e 0%, #0d47a1 100%); color: white; min-height: 100vh; padding: 20px; }
        .admin-container { max-width: 1200px; margin: 0 auto; }
        .admin-header { text-align: center; padding: 20px; background: rgba(0,0,0,0.3); border-radius: 10px; margin-bottom: 20px; border: 3px solid #ffd700; }
        .admin-title { font-size: 28px; color: #ffd700; margin-bottom: 10px; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: rgba(0,0,0,0.4); padding: 20px; border-radius: 10px; border: 2px solid #28a745; text-align: center; }
        .stat-value { font-size: 36px; font-weight: bold; color: #ffd700; margin: 10px 0; }
        .stat-label { color: #ccc; font-size: 14px; }
        .admin-sections { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
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
            <p>Server: <span id="serverStatus">Loading...</span></p>
            <div>
                <button class="btn btn-primary" id="refreshBtn">Refresh</button>
                <button class="btn btn-warning" id="callNumberBtn">Call Random Number</button>
                <button class="btn btn-danger" id="resetBtn">Reset Game</button>
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
                    <span id="wsStatusText">Checking...</span>
                </div>
            </div>
        </div>
        
        <div class="admin-sections">
            <div class="section">
                <h2 class="section-title">Game Control</h2>
                <div>
                    <input type="number" id="manualNumber" min="1" max="90" placeholder="Enter number (1-90)">
                    <button class="btn btn-primary" id="callManualBtn">Call Number</button>
                </div>
                <div style="margin-top: 15px;">
                    <input type="text" id="broadcastMsg" placeholder="Broadcast message">
                    <button class="btn btn-warning" id="broadcastBtn">Broadcast</button>
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
                    this.addLog('WebSocket error: ' + error.message, 'error');
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
                    document.getElementById('uptime').textContent = Math.floor(data.uptime) + 's';
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
                // Refresh button
                document.getElementById('refreshBtn').addEventListener('click', () => {
                    this.loadStats();
                });
                
                // Call random number
                document.getElementById('callNumberBtn').addEventListener('click', () => {
                    this.callRandomNumber();
                });
                
                // Call manual number
                document.getElementById('callManualBtn').addEventListener('click', () => {
                    this.callManualNumber();
                });
                
                // Broadcast message
                document.getElementById('broadcastBtn').addEventListener('click', () => {
                    this.sendBroadcast();
                });
                
                // Reset game
                document.getElementById('resetBtn').addEventListener('click', () => {
                    if (confirm('Are you sure you want to reset the game?')) {
                        this.resetGame();
                    }
                });
                
                // Clear logs
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
                    this.addLog(\`Admin called number: \${number}\`, 'info');
                }
            }
            
            sendBroadcast() {
                const input = document.getElementById('broadcastMsg');
                const message = input.value.trim();
                
                if (message && this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({
                        type: 'chat',
                        message: \`[ADMIN] \${message}\`,
                        broadcast: true
                    }));
                    
                    this.addLog(\`Broadcast: \${message}\`, 'info');
                    input.value = '';
                }
            }
            
            resetGame() {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({
                        type: 'reset-game',
                        timestamp: Date.now()
                    }));
                    
                    this.addLog('Game reset by admin', 'warning');
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
                
                // Store log
                this.logs.push({ timestamp, message, type });
                if (this.logs.length > 100) this.logs.shift();
            }
            
            clearLogs() {
                document.getElementById('serverLogs').innerHTML = '';
                this.logs = [];
                this.addLog('Logs cleared', 'info');
            }
        }
        
        // Initialize admin panel
        document.addEventListener('DOMContentLoaded', () => {
            window.adminPanel = new AdminPanel();
        });
    </script>
</body>
</html>`;
    
    // Write admin.html file
    await Deno.writeTextFile("frontend/admin.html", adminHtml);
    console.log("Admin HTML generated");
}

// ================ MAIN SERVER ================
async function main() {
    // Generate admin HTML if not exists
    try {
        await Deno.stat("frontend/admin.html");
    } catch {
        await generateAdminHtml();
    }
    
    // Create frontend directory if not exists
    try {
        await Deno.mkdir("frontend", { recursive: true });
    } catch {
        // Directory already exists
    }
    
    console.log(`🚀 Bingo Game Server starting on port ${PORT}`);
    console.log(`🔐 Admin password: ${ADMIN_PASSWORD}`);
    console.log(`🔗 Admin URL: http://localhost:${PORT}/admin.html?password=${ADMIN_PASSWORD}`);
    console.log(`🎮 Game URL: http://localhost:${PORT}`);
    console.log(`📡 WebSocket: ws://localhost:${PORT}/ws`);
    
    // Start server
    serve(handleRequest, { port: PORT });
}

// Start the server
if (import.meta.main) {
    main();
}

export { main };