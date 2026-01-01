import { FServer } from './server';

const port = process.env.PORT ? parseInt(process.env.PORT) : 9034;

try {
    new FServer(port);
} catch (e) {
    console.error("Failed to start server:", e);
    process.exit(1);
}
