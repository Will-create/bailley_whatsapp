import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';
import { RedisStore } from 'baileys-redis-store'; // Import RedisStore for managing Redis-based session storage
import pino from 'pino'; // Import Pino for logging
import { createClient, RedisClientType } from 'redis'; // Import Redis client utilities

/**
 * Main function to set up the WhatsApp socket connection and Redis store.
 */
async function main() {
    // Create a Redis client with connection options
    const redisClient: RedisClientType = createClient({
        url: "YOUR REDIS URL"
    });

    // Handle Redis connection errors
    redisClient.on('error', (err) => {
        console.error('Redis Client Error:', err);
        // Optionally attempt to reconnect
        // setTimeout(() => redisClient.connect(), 5000); // Retry connection after 5 seconds
    });

    // Connect to the Redis server
    try {
        await redisClient.connect();
        console.log('Connected to Redis successfully!');
    } catch (error) {
        console.error('Error connecting to Redis:', error);
        return; // Exit if connection fails
    }

    // Create a RedisStore instance for managing Baileys store data
    const store = new RedisStore({
        redisConnection: redisClient,
        prefix: 'store', // Optional prefix for Redis keys
        logger: pino({ level: 'debug' }), // Optional Pino logger instance
        maxCacheSize: 5000, // Maximum number of messages to cache locally (defaults to 1000)
    });

    // Load authentication state from multi-file storage
    const { state, saveCreds } = await useMultiFileAuthState('./Test');

    // Create a WhatsApp socket connection with the specified configuration
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        getMessage: store.getMessage.bind(store), // Bind the context for getMessage method
    });

    // Listen for credentials updates and save them
    sock.ev.on('creds.update', saveCreds);

    // Bind the store to the WhatsApp socket event emitter
    await store.bind(sock.ev as any);

    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];

        // Example of loading a specific message by ID
        const loadMessage = store.loadMessage("12343434@jid", "04FC413D6BE3C1XXXX");
        
        // Example of loading the latest messages (up to 40) for a specific chat
        const loadMessages = store.loadMessages("12343434@jid", 40);
    });

    // Gracefully disconnect from Redis on process exit
    process.on('SIGINT', async () => {
        console.log('Disconnecting from Redis...');
        await redisClient.quit();
        console.log('Disconnected from Redis.');
        process.exit(0); // Exit cleanly
    });
}

// Execute the main function and handle any errors
main().catch((error) => {
    console.error('Main function error:', error);
});