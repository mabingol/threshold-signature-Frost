"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const server_1 = require("./server");
const port = process.env.PORT ? parseInt(process.env.PORT) : 9034;
try {
    new server_1.FServer(port);
}
catch (e) {
    console.error("Failed to start server:", e);
    process.exit(1);
}
