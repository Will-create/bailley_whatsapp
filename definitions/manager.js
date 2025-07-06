
ON('ready', async function() {
    // Initialize the session manager
    // The manager can handle multiple WhatsApp instances.
    const manager = new MAIN.WhatsAppSessionManager({
        // Global config for all instances, can be overridden per instance
        redisUrl: CONF.redisUrl, // Assuming redisUrl is in your CONF
        authDir: 'databases',
        maxInstances: 100, // Max instances this manager can handle
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('Shutting down session manager...');
        await manager.gracefulShutdown();
        process.exit(0); 
    });

    // Example: Create an instance with pairing code
    async function initializeInstance(phone, config = {}) {
        try {
            console.log(`Attempting to create instance for ${phone}...`);

            // Configuration for this specific instance
            const instanceConfig = {
                ...CONF, // Base config from your application's configuration
                ...config, // Instance-specific config
            };

            const instance = await manager.createInstance(phone, instanceConfig);
            console.log(`Instance for ${phone} created with ID: ${instance.id}`);

            // --- Set up event listeners for the instance ---

            instance.on('pairing-code', (data) => {
                console.log(`[${data.phone}] Pairing Code: ${data.code}`);
                // You can now display this code to the user
            });

            instance.on('qr', (qr) => {
                // This will be triggered if usePairingCode is false
                console.log(`[${instance.phone}] QR code received. Scan with your phone.`);
                // You could convert this to a data URL and show it in a web UI
                // e.g., require('qrcode').toDataURL(qr).then(url => ...);
            });

            instance.on('ready', () => {
                console.log(`[${instance.phone}] Instance is ready and connected!`);
                // Now you can send messages
                // instance.sendMessage('RECIPIENT_JID@s.whatsapp.net', { text: 'Hello from my bot!' });
            });

            instance.on('message', (message) => {
                console.log(`[${instance.phone}] New message received:`, JSON.stringify(message, null, 2));
                // Add your message processing logic here
            });

            instance.on('logged-out', () => {
                console.warn(`[${instance.phone}] Instance logged out. It will be removed.`);
                // The manager should handle removal, but you can add custom logic here.
            });

            instance.on('error', (error) => {
                console.error(`[${instance.phone}] An error occurred:`, error);
            });

            instance.on('shutdown', () => {
                console.log(`[${instance.phone}] Instance has been shut down.`);
            });

            return instance;

        } catch (error) {
            console.error(`Failed to initialize instance for ${phone}:`, error);
            // Maybe retry or notify an admin
            throw error; // Re-throw to be handled by the caller
        }
    }

    // --- Example Usage ---

    // Initialize one instance on startup
    const initialPhone = '22655416464';
    await initializeInstance(initialPhone, { usePairingCode: true });


    // You can also create/remove instances dynamically, for example via an API endpoint.
    // Example of how you might expose this via Total.js routing:

    ROUTE('POST /api/instances', async function() {
        const self = this;
        const { phone, usePairingCode = true } = self.body;

        if (!phone) {
            return self.invalid('`phone` is required.');
        }

        if (manager.getInstance(phone)) {
            return self.invalid(`Instance for ${phone} already exists.`);
        }

        try {
            const instance = await initializeInstance(phone, { usePairingCode });
            self.json({ success: true, id: instance.id, phone: instance.phone });
        } catch (error) {
            self.invalid(error.message);
        }
    });

    ROUTE('DELETE /api/instances/{phone}', async function(phone) {
        const self = this;
        if (!manager.getInstance(phone)) {
            return self.invalid(`Instance for ${phone} not found.`);
        }

        try {
            await manager.removeInstance(phone, 'api_request');
            self.json({ success: true, message: `Instance for ${phone} removed.` });
        } catch (error) {
            self.invalid(error.message);
        }
    });

    ROUTE('GET /api/instances/{phone}/status', function(phone) {
        const self = this;
        const instance = manager.getInstance(phone);
        if (!instance) {
            return self.invalid(`Instance for ${phone} not found.`);
        }
        self.json(instance.getHealth());
    });

    ROUTE('GET /api/instances/status', function() {
        const self = this;
        self.json(manager.getHealthStatus());
    });

    ROUTE('POST /api/instances/{phone}/pairing-code/refresh', async function(phone) {
        const self = this;
        const instance = manager.getInstance(phone);
        if (!instance) {
            return self.invalid(`Instance for ${phone} not found.`);
        }

        try {
            await instance.refreshPairingCode();
            self.success();
        } catch (error) {
            self.invalid(error.message);
        }
    });

});