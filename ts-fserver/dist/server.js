"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FServer = void 0;
const ws_1 = require("ws");
const uuid = __importStar(require("uuid"));
const uuidv4 = uuid.v4;
const wasm = __importStar(require("tokamak-frost-wasm"));
function mapToObj(map, valueExtractor) {
    const obj = {};
    map.forEach((v, k) => {
        obj[k] = valueExtractor(v);
    });
    return obj;
}
class FServer {
    constructor(port) {
        this.connections = new Map();
        this.dkgSessions = new Map();
        this.signSessions = new Map();
        // Completed sessions storage (like fserver)
        this.completedDKGSessions = new Map();
        this.completedSignSessions = new Map();
        // Bind to 0.0.0.0 to ensure IPv4 access (fixes issues on Windows/Ubuntu where :: doesn't cover 127.0.0.1)
        this.wss = new ws_1.WebSocketServer({ port, host: '0.0.0.0' });
        this.wss.on('connection', (ws) => this.handleConnection(ws));
        console.log(`ts-fserver started on port ${port} (bound to 0.0.0.0)`);
    }
    handleConnection(ws) {
        const connId = uuidv4();
        const authSocket = { ws, id: connId };
        this.connections.set(connId, authSocket);
        console.log(`New connection: ${connId}`);
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(authSocket, msg);
            }
            catch (e) {
                console.error(`Failed to parse message from ${connId}:`, e);
            }
        });
        ws.on('close', () => {
            console.log(`Connection closed: ${connId}`);
            this.handleDisconnect(authSocket);
        });
    }
    handleDisconnect(socket) {
        this.connections.delete(socket.id);
        // Logic for removing from sessions if needed, though usually sessions persist
        // If a user disconnects mid-round, the session might stall.
    }
    send(ws, msg) {
        if (ws.readyState === ws_1.WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }
    broadcastUserList(sessionId) {
        // Not strictly required by protocol but helpful for debugging
    }
    handleMessage(socket, msg) {
        console.log(`[${socket.id}] Recv: ${msg.type}`);
        // console.log(JSON.stringify(msg.payload, null, 2));
        switch (msg.type) {
            // ----------------------------------------------------------------
            // AUTH
            // ----------------------------------------------------------------
            case 'RequestChallenge': {
                const challenge = uuidv4(); // Standard UUID string
                socket.challenge = challenge;
                this.send(socket.ws, { type: 'Challenge', payload: { challenge } });
                break;
            }
            case 'Login': {
                const { challenge, public_key, signature_hex } = msg.payload;
                if (challenge !== socket.challenge) {
                    this.send(socket.ws, { type: 'Error', payload: { message: "Invalid challenge" } });
                    return;
                }
                // Convert UUID challenge string to hex bytes for verification
                // UUID is 16 bytes.
                let challengeHex = "";
                try {
                    const bytes = uuid.parse(challenge);
                    challengeHex = Buffer.from(bytes).toString('hex');
                }
                catch (e) {
                    this.send(socket.ws, { type: 'Error', payload: { message: "Invalid challenge format" } });
                    return;
                }
                try {
                    // @ts-ignore - verify_signature added recently
                    const valid = wasm.verify_signature(public_key, challengeHex, signature_hex);
                    if (!valid) {
                        this.send(socket.ws, { type: 'Error', payload: { message: "Signature verification failed" } });
                        return;
                    }
                }
                catch (e) {
                    console.error("Verification error:", e);
                    this.send(socket.ws, { type: 'Error', payload: { message: "Verification error" } });
                    return;
                }
                let pubKeyStr;
                if (typeof public_key === 'string')
                    pubKeyStr = public_key;
                else
                    pubKeyStr = public_key.key;
                socket.publicKey = pubKeyStr;
                this.send(socket.ws, {
                    type: 'LoginOk',
                    payload: {
                        principal: pubKeyStr,
                        suid: 0, // Assigned on join
                        access_token: uuidv4()
                    }
                });
                break;
            }
            case 'Logout': {
                // Remove connection and clear authentication (like fserver lines 757-770)
                socket.publicKey = undefined;
                socket.challenge = undefined;
                this.send(socket.ws, { type: 'Info', payload: { message: 'Logged out' } });
                break;
            }
            // ----------------------------------------------------------------
            // DKG SESSION MANAGEMENT
            // ----------------------------------------------------------------
            case 'AnnounceDKGSession': {
                // Note: Rust server generates ID.
                const sessionID = uuidv4();
                const { min_signers, max_signers, group_id, participants, participants_pubs } = msg.payload;
                const session = {
                    id: sessionID,
                    creatorSocketId: socket.id,
                    min_signers,
                    max_signers,
                    group_id,
                    participants_config: participants,
                    participants_pubs,
                    joined_participants: new Map(),
                    state: 'Pending',
                    round1_packages: new Map(),
                    round2_packages: new Map(), // Stores *incoming* packages for users
                    created_at: Date.now()
                };
                this.dkgSessions.set(sessionID, session);
                this.send(socket.ws, { type: 'DKGSessionCreated', payload: { session: sessionID } });
                break;
            }
            case 'JoinDKGSession': {
                const { session: sid } = msg.payload;
                const session = this.dkgSessions.get(sid);
                if (!session) {
                    this.send(socket.ws, { type: 'Error', payload: { message: "Session not found" } });
                    return;
                }
                if (!socket.publicKey) {
                    this.send(socket.ws, { type: 'Error', payload: { message: "Not logged in" } });
                    return;
                }
                // Find configured participant ID (suid) for this pubkey
                const pubEntry = session.participants_pubs.find(p => {
                    const k = typeof p[1] === 'string' ? p[1] : p[1].key;
                    // Simple string match (ignore case/prefix for robustness if needed)
                    return k.toLowerCase().replace('0x', '') === socket.publicKey.toLowerCase().replace('0x', '');
                });
                if (!pubEntry) {
                    this.send(socket.ws, { type: 'Error', payload: { message: "Public key not authorized for this session" } });
                    return;
                }
                const suid = pubEntry[0];
                session.joined_participants.set(suid, { uid: suid, socketId: socket.id, pubKeyProp: pubEntry[1] });
                this.send(socket.ws, { type: 'Info', payload: { message: `Joined session ${sid} as participant ${suid}` } });
                // Broadcast update
                session.joined_participants.forEach(p => {
                    const pSocket = this.connections.get(p.socketId);
                    if (pSocket)
                        this.send(pSocket.ws, { type: 'Info', payload: { message: `participant ${suid} joined session ${sid}` } });
                });
                // Check if all joined
                console.log(`Session ${sid}: Joined ${session.joined_participants.size} / ${session.max_signers}`);
                if (session.joined_participants.size === session.max_signers) {
                    console.log("Starting DKG Round 1...");
                    this.startDKGRound1(session);
                }
                break;
            }
            case 'ListPendingDKGSessions': {
                const list = Array.from(this.dkgSessions.values())
                    .filter(s => s.state !== 'Finalized' && s.state !== 'Failed')
                    .map(s => ({
                    session: s.id,
                    group_id: s.group_id,
                    min_signers: s.min_signers,
                    max_signers: s.max_signers,
                    participants: s.participants_config,
                    participants_pubs: s.participants_pubs,
                    joined: Array.from(s.joined_participants.keys()),
                    created_at: new Date(s.created_at).toISOString() // Rust uses string
                }));
                this.send(socket.ws, { type: 'PendingDKGSessions', payload: { sessions: list } });
                break;
            }
            case 'ListCompletedDKGSessions': {
                // Return completed DKG sessions user participated in (like fserver lines 916-935)
                if (!socket.publicKey) {
                    this.send(socket.ws, { type: 'Error', payload: { message: 'Must login first' } });
                    return;
                }
                const completedList = Array.from(this.completedDKGSessions.values())
                    .filter(s => {
                    // Check if user's public key is in participants_pubs
                    return s.participants_pubs.some(([_, pubKey]) => {
                        const pubKeyStr = typeof pubKey === 'string' ? pubKey : JSON.stringify(pubKey);
                        return pubKeyStr === socket.publicKey || JSON.stringify(pubKey).includes(socket.publicKey);
                    });
                });
                this.send(socket.ws, { type: 'CompletedDKGSessions', payload: { sessions: completedList } });
                break;
            }
            // ----------------------------------------------------------------
            // DKG ROUNDS
            // ----------------------------------------------------------------
            case 'Round1Submit': {
                const { session: sid, id_hex, pkg_bincode_hex, signature_hex } = msg.payload;
                const session = this.dkgSessions.get(sid);
                if (!session)
                    return;
                const participant = Array.from(session.joined_participants.values()).find(p => p.socketId === socket.id);
                if (!participant || !participant.pubKeyProp) {
                    this.send(socket.ws, { type: 'Error', payload: { message: "Not a participant or not logged in" } });
                    return;
                }
                participant.frostIdHex = id_hex;
                try {
                    const authPayload = wasm.get_auth_payload_round1(sid, id_hex, pkg_bincode_hex);
                    const valid = wasm.verify_signature(participant.pubKeyProp, authPayload, signature_hex);
                    console.log(`[Round1] Validating ${id_hex.substring(0, 8)}... Result: ${valid}`);
                    if (!valid) {
                        this.send(socket.ws, { type: 'Error', payload: { message: "Invalid signature" } });
                        return;
                    }
                }
                catch (e) {
                    console.error("Verification error:", e);
                    this.send(socket.ws, { type: 'Error', payload: { message: "Verification failed" } });
                    return;
                }
                session.round1_packages.set(id_hex, { pkg: pkg_bincode_hex, sig: signature_hex });
                // Check if all submitted
                if (session.round1_packages.size === session.max_signers) {
                    this.finishDKGRound1(session);
                }
                break;
            }
            case 'Round2Submit': {
                const { session: sid, id_hex, pkgs_cipher } = msg.payload;
                const session = this.dkgSessions.get(sid);
                if (!session)
                    return;
                const sender = Array.from(session.joined_participants.values()).find(p => p.socketId === socket.id);
                if (!sender || !sender.pubKeyProp) {
                    this.send(socket.ws, { type: 'Error', payload: { message: "Unauthorized" } });
                    return;
                }
                // Distribute packages to recipients
                for (const [recipient_id, encrypted_payload, sig] of pkgs_cipher) {
                    try {
                        // Extract fields from EncryptedPayload (web UI sends decomposed format)
                        let ephHex, nonceHex, ctHex;
                        // Handle both decomposed EncryptedPayload object and raw hex string
                        if (typeof encrypted_payload === 'string') {
                            // For compatibility with tests that might send raw hex
                            ephHex = encrypted_payload;
                            nonceHex = '';
                            ctHex = '';
                        }
                        else {
                            // Web UI format: { ephemeral_public_key: { type, key }, nonce, ciphertext }
                            const eph = encrypted_payload.ephemeral_public_key;
                            ephHex = typeof eph === 'string' ? eph : eph.key;
                            nonceHex = encrypted_payload.nonce;
                            ctHex = encrypted_payload.ciphertext;
                        }
                        const authPayload = wasm.get_auth_payload_round2(sid, id_hex, recipient_id, ephHex, nonceHex, ctHex);
                        if (!wasm.verify_signature(sender.pubKeyProp, authPayload, sig)) {
                            console.error(`Invalid signature round2 from ${id_hex} to ${recipient_id}`);
                            this.send(socket.ws, { type: 'Error', payload: { message: "Invalid signature in package" } });
                            return;
                        }
                    }
                    catch (e) {
                        console.error("Verification error R2:", e);
                        this.send(socket.ws, { type: 'Error', payload: { message: "Verification error" } });
                        return;
                    }
                    if (!session.round2_packages.has(recipient_id)) {
                        session.round2_packages.set(recipient_id, []);
                    }
                    session.round2_packages.get(recipient_id).push([id_hex, encrypted_payload, sig]);
                }
                // Ideally wait for ALL participants to submit ALL their packages
                // Count total received packages? 
                // Simplified: Wait until we have (N-1) packages for EVERY recipient
                const N = session.max_signers;
                let ready = true;
                // Check that every participant has received N-1 packages
                // (We iterate over the *expected* recipients, i.e. joined participants)
                session.joined_participants.forEach((p, suid) => {
                    // We need to look up their id_hex. But we map state by id_hex?
                    // Wait, server usually maps via id_hex.
                    // We need map from suid -> id_hex. That comes from R1?
                    // The client sends id_hex. We should store that in participant state in R1.
                });
                // Actually, simply check total packages count? N * (N-1)
                let totalPackages = 0;
                session.round2_packages.forEach(list => totalPackages += list.length);
                if (totalPackages === N * (N - 1)) {
                    this.finishDKGRound2(session);
                }
                break;
            }
            case 'FinalizeSubmit': {
                const { session: sid, id_hex, group_vk_sec1_hex, signature_hex } = msg.payload;
                const session = this.dkgSessions.get(sid);
                if (!session)
                    return;
                const participant = Array.from(session.joined_participants.values()).find(p => p.socketId === socket.id);
                if (!participant || !participant.pubKeyProp) {
                    this.send(socket.ws, { type: 'Error', payload: { message: "Unauthorized" } });
                    return;
                }
                try {
                    const authPayload = wasm.get_auth_payload_finalize(sid, id_hex, group_vk_sec1_hex);
                    // Verify signature
                    if (!wasm.verify_signature(participant.pubKeyProp, authPayload, signature_hex)) {
                        this.send(socket.ws, { type: 'Error', payload: { message: "Invalid signature" } });
                        return;
                    }
                }
                catch (e) {
                    console.error("Verification error Finalize:", e);
                    this.send(socket.ws, { type: 'Error', payload: { message: "Verification error" } });
                    return;
                }
                // Verify that this user is actually id_hex (matches their frostIdHex from Round1)
                if (participant.frostIdHex && participant.frostIdHex !== id_hex) {
                    console.error(`ID mismatch: participant ${participant.uid} claimed ${id_hex} but expected ${participant.frostIdHex}`);
                    this.send(socket.ws, { type: 'Error', payload: { message: "Identifier mismatch" } });
                    return;
                }
                // Group key consistency check (like fserver lines 1235-1242)
                if (session.final_group_key) {
                    if (session.final_group_key !== group_vk_sec1_hex) {
                        console.error(`Group VK mismatch from uid ${participant.uid}: got ${group_vk_sec1_hex}, expected ${session.final_group_key}`);
                        this.send(socket.ws, { type: 'Error', payload: { message: "Group key mismatch" } });
                        return;
                    }
                }
                else {
                    // First participant to finalize sets the expected group key
                    session.final_group_key = group_vk_sec1_hex;
                }
                // Track finalized participants (like fserver line 1247)
                if (!session.finalized_uids) {
                    session.finalized_uids = new Set();
                }
                session.finalized_uids.add(participant.uid);
                console.log(`[server] Finalize progress: ${session.finalized_uids.size}/${session.max_signers} (session=${sid})`);
                // Check if all participants have finalized (like fserver lines 1255-1298)
                if (session.finalized_uids.size === session.max_signers) {
                    session.state = 'Finalized';
                    // Broadcast Finalized to all participants
                    session.joined_participants.forEach((p) => {
                        const pSocket = this.connections.get(p.socketId);
                        if (pSocket) {
                            this.send(pSocket.ws, {
                                type: 'Finalized',
                                payload: { session: sid, group_vk_sec1_hex }
                            });
                        }
                    });
                    console.log(`[server] DKG session ${sid} fully finalized.`);
                }
                else {
                    // Send acknowledgment to this participant only
                    this.send(socket.ws, {
                        type: 'Finalized',
                        payload: { session: sid, group_vk_sec1_hex }
                    });
                }
                break;
            }
            // ----------------------------------------------------------------
            // SIGNING SESSION
            // ----------------------------------------------------------------
            case 'AnnounceSignSession': {
                const sessionID = uuidv4();
                const { group_id, threshold, participants, participants_pubs, message, message_hex, group_vk_sec1_hex } = msg.payload;
                const session = {
                    id: sessionID,
                    creatorSocketId: socket.id,
                    group_id,
                    threshold,
                    participants_config: participants,
                    participants_pubs,
                    message,
                    message_hex,
                    group_vk_sec1_hex,
                    joined_participants: new Map(),
                    state: 'Pending',
                    round1_commitments: new Map(),
                    round2_shares: new Map(),
                    created_at: Date.now()
                };
                this.signSessions.set(sessionID, session);
                // Ack to creator
                this.send(socket.ws, { type: 'SignSessionCreated', payload: { session: sessionID } });
                // Broadcast to all to notify new available session
                // NOTE: Real fserver might only notify relevant users or multicast.
                // But clients often poll anyway. 
                // Let's send a broadcast 'Info' or just let them poll.
                break;
            }
            case 'ListPendingSigningSessions': {
                const list = Array.from(this.signSessions.values())
                    .filter(s => s.state !== 'Complete' && s.state !== 'Failed')
                    .map(s => ({
                    session: s.id,
                    group_id: s.group_id,
                    threshold: s.threshold,
                    participants: s.participants_config,
                    participants_pubs: s.participants_pubs,
                    message: s.message,
                    message_hex: s.message_hex,
                    status: s.state,
                    created_at: new Date(s.created_at).toISOString(),
                    joined: Array.from(s.joined_participants.values()).map(p => ({
                        // Return simplified participant info for UI
                        uid: p.uid,
                        pub_key: typeof p.pubKeyProp === 'string' ? p.pubKeyProp : p.pubKeyProp?.key
                    }))
                }));
                this.send(socket.ws, { type: 'PendingSigningSessions', payload: { sessions: list } });
                break;
            }
            case 'ListCompletedSigningSessions': {
                // Return completed signing sessions user participated in (like fserver lines 975-995)
                if (!socket.publicKey) {
                    this.send(socket.ws, { type: 'Error', payload: { message: 'Must login first' } });
                    return;
                }
                const completedList = Array.from(this.completedSignSessions.values())
                    .filter(s => {
                    // Check if user's public key is in participants_pubs
                    return s.participants_pubs.some(([_, pubKey]) => {
                        const pubKeyStr = typeof pubKey === 'string' ? pubKey : JSON.stringify(pubKey);
                        return pubKeyStr === socket.publicKey || JSON.stringify(pubKey).includes(socket.publicKey);
                    });
                });
                this.send(socket.ws, { type: 'CompletedSigningSessions', payload: { sessions: completedList } });
                break;
            }
            case 'JoinSignSession': {
                const { session: sid, signer_id_bincode_hex, verifying_share_bincode_hex } = msg.payload;
                const session = this.signSessions.get(sid);
                if (!session) {
                    this.send(socket.ws, { type: 'Error', payload: { message: "Signing session not found" } });
                    return;
                }
                if (!socket.publicKey) {
                    this.send(socket.ws, { type: 'Error', payload: { message: "Not logged in" } });
                    return;
                }
                // Identify user from roster
                const pubEntry = session.participants_pubs.find(p => {
                    const k = typeof p[1] === 'string' ? p[1] : p[1].key;
                    return k.toLowerCase().replace('0x', '') === socket.publicKey.toLowerCase().replace('0x', '');
                });
                if (!pubEntry) {
                    this.send(socket.ws, { type: 'Error', payload: { message: "Public key not in signing roster" } });
                    return;
                }
                const suid = pubEntry[0];
                session.joined_participants.set(suid, {
                    uid: suid,
                    socketId: socket.id,
                    pubKeyProp: pubEntry[1],
                    signer_id_hex: signer_id_bincode_hex,
                    verifying_share: verifying_share_bincode_hex
                });
                // this.send(socket.ws, { type: 'SignSessionJoined', payload: { session: sid } });
                // Broadcast info
                session.joined_participants.forEach(p => {
                    const pSocket = this.connections.get(p.socketId);
                    if (pSocket)
                        this.send(pSocket.ws, { type: 'Info', payload: { message: `participant ${suid} joined session ${sid}` } });
                });
                // Check if enough joined (Threshold)
                // Note: Unlike DKG (all N), signing requires T.
                // But usually we wait for configurable amount?
                // Actually fserver logic waits for exact subset? 
                // Or just waits for "enough"?
                // Let's assume we wait for ALL listed participants in `participants_config`?
                // Or just `threshold`? 
                // Looking at `AnnounceSignSession` in `types.ts`, it has `participants` list.
                // So we wait for everyone in that list.
                if (session.joined_participants.size === session.participants_config.length) {
                    this.startSignRound1(session);
                }
                break;
            }
            case 'SignRound1Submit': {
                const { session: sid, id_hex, commitments_bincode_hex, signature_hex } = msg.payload;
                const session = this.signSessions.get(sid);
                if (!session)
                    return;
                const participant = Array.from(session.joined_participants.values()).find(p => p.socketId === socket.id);
                if (!participant || !participant.pubKeyProp) {
                    this.send(socket.ws, { type: 'Error', payload: { message: "Unauthorized" } });
                    return;
                }
                try {
                    const authPayload = wasm.get_auth_payload_sign_r1(sid, session.group_id, id_hex, commitments_bincode_hex);
                    if (!wasm.verify_signature(participant.pubKeyProp, authPayload, signature_hex)) {
                        this.send(socket.ws, { type: 'Error', payload: { message: "Invalid signature" } });
                        return;
                    }
                }
                catch (e) {
                    console.error("Verification error Sign R1:", e);
                    this.send(socket.ws, { type: 'Error', payload: { message: "Verification error" } });
                    return;
                }
                session.round1_commitments.set(id_hex, { commitment: commitments_bincode_hex, sig: signature_hex });
                if (session.round1_commitments.size === session.participants_config.length) {
                    this.finishSignRound1(session);
                }
                break;
            }
            case 'SignRound2Submit': {
                const { session: sid, id_hex, signature_share_bincode_hex, signature_hex } = msg.payload;
                const session = this.signSessions.get(sid);
                if (!session)
                    return;
                const participant = Array.from(session.joined_participants.values()).find(p => p.socketId === socket.id);
                if (!participant || !participant.pubKeyProp) {
                    this.send(socket.ws, { type: 'Error', payload: { message: "Unauthorized" } });
                    return;
                }
                try {
                    const authPayload = wasm.get_auth_payload_sign_r2(sid, session.group_id, id_hex, signature_share_bincode_hex, session.message_hex);
                    if (!wasm.verify_signature(participant.pubKeyProp, authPayload, signature_hex)) {
                        this.send(socket.ws, { type: 'Error', payload: { message: "Invalid signature" } });
                        return;
                    }
                }
                catch (e) {
                    console.error("Verification error Sign R2:", e);
                    this.send(socket.ws, { type: 'Error', payload: { message: "Verification error" } });
                    return;
                }
                session.round2_shares.set(id_hex, { share: signature_share_bincode_hex, sig: signature_hex });
                if (session.round2_shares.size === session.participants_config.length) {
                    this.finishSignRound2(session);
                }
                break;
            }
        }
    }
    // ----------------------------------------------------------------
    // PROTOCOL HELPERS
    // ----------------------------------------------------------------
    startDKGRound1(session) {
        session.state = 'Round1';
        // Need to assign id_hex to participants? 
        // Actually, in DKG R1, clients GENERATE their id_hex and sending it in R1Submit.
        // But server sends "ReadyRound1".
        // Rust fserver: sends `id_hex` in `ReadyRound1` payload?
        // Wait, let's check `types.ts` definition of `ReadyRound1`.
        // It has `id_hex` at the top level? No, checking logic...
        // `ReadyRound1`: { session, group_id, min/max, roster: [uid, id_hex, pub] }
        // Where does `id_hex` come from?
        // Ah, in Rust `fserver`, `id_hex` seems to be deterministic or pre-assigned?
        // Or maybe the server generates it?
        // Checking `fserver/src/main.rs`: 
        // "Server generates random identifiers for them?"
        // Re-reading `useDKGWebSocket.ts`: 
        // "const myIdentifierHex = msg.payload.id_hex;"
        // So Server sends it.
        // Let's generate random id_hex (scalar) for each participant.
        // 32 bytes hex.
        const roster = [];
        session.joined_participants.forEach(p => {
            // Use deterministic ID based on UID (1, 2, 3) to allow easier file mapping in tests/Makefile
            // Pad to 32 bytes (64 hex chars)
            const idVal = BigInt(p.uid);
            p.frostIdHex = idVal.toString(16).padStart(64, '0');
            roster.push([p.uid, p.frostIdHex, p.pubKeyProp]);
        });
        session.joined_participants.forEach(p => {
            const socket = this.connections.get(p.socketId);
            if (socket) {
                this.send(socket.ws, {
                    type: 'ReadyRound1',
                    payload: {
                        session: session.id,
                        group_id: session.group_id,
                        min_signers: session.min_signers,
                        max_signers: session.max_signers,
                        roster: roster,
                        id_hex: p.frostIdHex // Personal ID
                    }
                });
            }
        });
    }
    finishDKGRound1(session) {
        session.state = 'Round2';
        // Broadcast all packages
        const packages = [];
        session.round1_packages.forEach((val, id_hex) => {
            packages.push([id_hex, val.pkg, val.sig]);
        });
        session.joined_participants.forEach(p => {
            const socket = this.connections.get(p.socketId);
            if (socket) {
                this.send(socket.ws, {
                    type: 'Round1All',
                    payload: { session: session.id, packages }
                });
                // Also trigger ReadyRound2
                // The client waits for Round1All then expects ReadyRound2?
                // Or does it transition automatically?
                // `useDKGWebSocket.ts`: handles `Round1All` (stores pkgs), handles `ReadyRound2` (starts R2).
                // So send both.
                this.send(socket.ws, {
                    type: 'ReadyRound2',
                    payload: { session: session.id, participants: [] } // payload content?
                });
            }
        });
    }
    finishDKGRound2(session) {
        // Distribute encrypted packages
        session.joined_participants.forEach(p => {
            const socket = this.connections.get(p.socketId);
            if (!socket || !p.frostIdHex)
                return;
            // Get packages destined for this user
            const incoming = session.round2_packages.get(p.frostIdHex) || [];
            this.send(socket.ws, {
                type: 'Round2All',
                payload: {
                    session: session.id,
                    packages: incoming
                }
            });
        });
    }
    // SIGNING
    startSignRound1(session) {
        session.state = 'Round1';
        const roster = [];
        session.joined_participants.forEach(p => {
            // We need to map back to the 'id' they used in DKG.
            // In `handleConnection`, we don't know it.
            // BUT, `JoinSignSession` payload had `signer_id_bincode_hex`.
            // We stored it in `signer_id_hex`.
            // That is the `id_hex`.
            if (!p.signer_id_hex) {
                console.error("Missing signer_id_hex for participant", p.uid);
                return;
            }
            roster.push([p.uid, p.signer_id_hex, p.pubKeyProp]);
        });
        session.joined_participants.forEach(p => {
            const socket = this.connections.get(p.socketId);
            if (socket) {
                this.send(socket.ws, {
                    type: 'SignReadyRound1',
                    payload: {
                        session: session.id,
                        group_id: session.group_id,
                        threshold: session.threshold,
                        participants: session.participants_config.length,
                        roster: roster,
                        msg_keccak32_hex: session.message_hex // Client needs hash
                    }
                });
            }
        });
    }
    finishSignRound1(session) {
        session.state = 'Round2';
        console.log(`[server] Aggregating Commitments for session ${session.id}...`);
        try {
            const commitmentsObj = mapToObj(session.round1_commitments, (v) => v.commitment);
            const signingPackageHex = wasm.compute_signing_package(commitmentsObj, session.message_hex);
            session.signing_package = signingPackageHex;
            // Broadcast SignSigningPackage
            session.joined_participants.forEach(p => {
                const pSocket = this.connections.get(p.socketId);
                if (pSocket)
                    this.send(pSocket.ws, {
                        type: 'SignSigningPackage',
                        payload: {
                            session: session.id,
                            signing_package_bincode_hex: signingPackageHex
                        }
                    });
            });
            console.log(`[server] Broadcasted SigningPackage for session ${session.id}`);
        }
        catch (e) {
            console.error(`[server] Aggregation failed: ${e.message}`);
            // Notify all participants about the error
            session.joined_participants.forEach(p => {
                const pSocket = this.connections.get(p.socketId);
                if (pSocket) {
                    this.send(pSocket.ws, {
                        type: 'Error',
                        payload: { message: `Signing Round 1 aggregation failed: ${e.message}` }
                    });
                }
            });
        }
    }
    finishSignRound2(session) {
        console.log(`[server] Aggregating Signatures for session ${session.id}...`);
        try {
            const sharesObj = mapToObj(session.round2_shares, (v) => v.share);
            // Reconstruct verifying shares map (signer_id_hex -> share)
            const vsharesObj = {};
            session.joined_participants.forEach((p) => {
                if (p.signer_id_hex && p.verifying_share) {
                    vsharesObj[p.signer_id_hex] = p.verifying_share;
                }
                else if (p.pubKeyProp && typeof p.pubKeyProp !== 'string' && 'key' in p.pubKeyProp) {
                    // CAUTION: This might be where `verifying_share` is supposedly stored?
                    // No, `handleConnection` or `JoinSignSession` should have populated it.
                    // But `JoinSignSession` logic only set `signer_id_hex`.
                    // Where is `verifying_share`?
                    // Client `JoinSignSession` payload: `verifying_share_bincode_hex`.
                    // Server `JoinSignSession` handler MUST store it.
                }
            });
            // Fix: Logic in JoinSignSession needs to store `verifying_share`.
            // Let's assume verifying_share_bincode_hex IS stored in p.verifying_share (we need to update Join handler too if missed).
            if (!session.signing_package)
                throw new Error("Missing signing package");
            const resultJson = wasm.aggregate_signatures(session.signing_package, sharesObj, vsharesObj, session.group_vk_sec1_hex);
            const result = JSON.parse(resultJson);
            session.final_signature = result.signature_bincode_hex;
            session.state = 'Complete';
            // Broadcast SignatureReady
            session.joined_participants.forEach(p => {
                const pSocket = this.connections.get(p.socketId);
                if (pSocket)
                    this.send(pSocket.ws, {
                        type: 'SignatureReady',
                        payload: {
                            session: session.id,
                            signature_bincode_hex: result.signature_bincode_hex,
                            message: session.message_hex,
                            rx: result.rx,
                            ry: result.ry,
                            s: result.s,
                            px: result.px,
                            py: result.py
                        }
                    });
            });
            console.log(`[server] Signature finalized for session ${session.id}`);
        }
        catch (e) {
            console.error(`[server] Signature aggregation failed: ${e.message}`);
            // Notify all participants about the error
            session.joined_participants.forEach(p => {
                const pSocket = this.connections.get(p.socketId);
                if (pSocket) {
                    this.send(pSocket.ws, {
                        type: 'Error',
                        payload: { message: `Signature aggregation failed: ${e.message}` }
                    });
                }
            });
        }
    }
}
exports.FServer = FServer;
