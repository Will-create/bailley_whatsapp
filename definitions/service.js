const { makeWASocket, useMultiFileAuthState, Browsers, getContentType, DisconnectReason } = require('baileys');
const { RedisStore } = require('baileys-redis-store');
const { createClient } = require('redis');
const pino = require('pino');
const EventEmitter = require('events');
const os = require('os');


const silentLogger = {
    info: NOOP,
    warn: NOOP,
    error: NOOP,
    trace: NOOP ,
    debug: console.log,
    child: () => silentLogger
};

// Production-grade logger with levels and structured logging
const createLogger = (phone) => {
    return silentLogger;
    return pino({
        level: process.env.LOG_LEVEL || 'debug',
        formatters: {
            level: (label) => ({ level: label.toUpperCase() }),
        },
        base: {
            phone,
            pid: process.pid,
            hostname: os.hostname()
        },
        timestamp: pino.stdTimeFunctions.isoTime,
    });
};

// Circuit breaker pattern for external services
class CircuitBreaker {
    constructor(fn, options = {}) {
        this.fn = fn;
        this.failureThreshold = options.failureThreshold || 5;
        this.resetTimeout = options.resetTimeout || 60000;
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
        this.failures = 0;
        this.nextAttempt = Date.now();
    }

    async execute(...args) {
        if (this.state === 'OPEN') {
            if (Date.now() < this.nextAttempt) {
                throw new Error('Circuit breaker is OPEN');
            }
            this.state = 'HALF_OPEN';
        }

        try {
            const result = await this.fn(...args);
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        }
    }

    onSuccess() {
        this.failures = 0;
        this.state = 'CLOSED';
    }

    onFailure() {
        this.failures++;
        if (this.failures >= this.failureThreshold) {
            this.state = 'OPEN';
            this.nextAttempt = Date.now() + this.resetTimeout;
        }
    }
}

// Resource monitor to prevent memory leaks and excessive resource usage
class ResourceMonitor extends EventEmitter {
    constructor(options = {}) {
        super();
        this.memoryThreshold = options.memoryThreshold || 500 * 1024 * 1024; // 500MB
        this.cpuThreshold = options.cpuThreshold || 80; // 80%
        this.interval = options.interval || 30000; // 30 seconds
        this.monitoring = false;
    }

    start() {
        if (this.monitoring) return;
        this.monitoring = true;

        this.timer = setInterval(() => {
            this.checkResources();
        }, this.interval);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.monitoring = false;
    }

    checkResources() {
        const memUsage = process.memoryUsage();
        const cpuUsage = process.cpuUsage();

        if (memUsage.heapUsed > this.memoryThreshold) {
            this.emit('memory-warning', memUsage);
        }

        // Force garbage collection if memory is high
        if (memUsage.heapUsed > this.memoryThreshold * 1.5) {
            if (global.gc) {
                global.gc();
            }
            this.emit('memory-critical', memUsage);
        }
    }
}

// Enhanced Redis connection with clustering support
class RedisManager {
    constructor(config) {
        this.config = config;
        this.clients = new Map();
        this.circuitBreaker = new CircuitBreaker(
            this.createConnection.bind(this),
            { failureThreshold: 3, resetTimeout: 30000 }
        );
    }

    async createConnection(instanceId) {
        const client = createClient({
            url: this.config.url,
            socket: {
                connectTimeout: 10000,
                lazyConnect: true,
                reconnectStrategy: (retries) => {
                    if (retries > 10) return new Error('Max reconnection attempts reached');
                    return Math.min(retries * 100, 3000);
                }
            },
            retry_unfulfilled_commands: true,
        });

        client.on('error', (err) => {
            console.error(`Redis error for ${instanceId}:`, err);
        });

        client.on('reconnecting', () => {
            console.log(`Redis reconnecting for ${instanceId}`);
        });

        await client.connect();
        return client;
    }

    async getClient(instanceId) {
        if (!this.clients.has(instanceId)) {
            try {
                const client = await this.circuitBreaker.execute(instanceId);
                this.clients.set(instanceId, client);
            } catch (error) {
                throw new Error(`Failed to create Redis client for ${instanceId}: ${error.message}`);
            }
        }
        return this.clients.get(instanceId);
    }

    async closeClient(instanceId) {
        const client = this.clients.get(instanceId);
        if (client) {
            await client.quit();
            this.clients.delete(instanceId);
        }
    }

    async closeAll() {
        const promises = Array.from(this.clients.entries()).map(([id, client]) =>
            client.quit().catch(err => console.error(`Error closing Redis client ${id}:`, err))
        );
        await Promise.allSettled(promises);
        this.clients.clear();
    }
}

// Production-grade WhatsApp instance with proper error handling and isolation
class WhatsAppInstance extends EventEmitter {
    constructor(phone, config = {}) {
        super();
        this.phone = phone;
        this.config = config;
        this.logger = createLogger(phone);
        this.state = 'INITIALIZING';
        this.socket = null;
        this.store = null;
        this.authState = null;
        this.redisClient = null;


        // Pairing code configuration
        this.usePairingCode = config.usePairingCode || false;
        this.pairingCodeTimeout = config.pairingCodeTimeout || 300000; // 5 minutes
        this.currentPairingCode = null;
        this.pairingCodeTimer = null;
        this.pairingAttempts = 0;
        this.maxPairingAttempts = 3;
        this.pairingCodeRequested = false;

        // Resource monitoring
        this.resourceMonitor = new ResourceMonitor({
            memoryThreshold: config.memoryThreshold || 100 * 1024 * 1024, // 100MB per instance
        });

        // Connection management
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = config.maxReconnectAttempts || 5;
        this.reconnectDelay = config.reconnectDelay || 5000;
        this.connectionTimeout = config.connectionTimeout || 60000;
        this.isShuttingDown = false;

        // Health check
        this.lastHeartbeat = Date.now();
        this.healthCheckInterval = config.healthCheckInterval || 30000;

        // Message queue for handling bursts
        this.messageQueue = [];
        this.processingQueue = false;
        this.maxQueueSize = config.maxQueueSize || 1000;

        this.setupEventHandlers();
        this.startHealthCheck();

        // Custom
        let t = this;
        t.db = DB();
        let filename = PATH.databases('memorize_' + phone + '.json');
        // check if memorize file exists, if not create it
        if (!Total.Fs.existsSync(filename)) { 
            Total.Fs.writeFileSync(filename, JSON.stringify(FUNC.getFormattedData(phone, CONF.baseurl), null, 2));
        }

        var w = t.memorize = MEMORIZE(phone);
        var data = w.data || {};
        data.id = UID();
        w.save();
        t.Worker = w;
        t.Data = data;
        t.id = data.id;
        t.port = CONF.port;
        t.ip = CONF.ip;
        t.origin = t.config.origin || 'zapwize';
        t.plans = [];
        t.chats = [];
        t.messages = [];
        t.logs = [{ name: 'instance_created', content: true }];
        t.code = '';
        t.qrcode = '';
        t.is_maxlimit = false;
        t.is_limit = false;
        t.ws_clients = {};
        t.days = {};
        t.qr_retry = 0;
        t.qr_max_retry = 0;
        t.tick = 0;
        t.tick2 = 0;
        t.tick_interval = 60;
        t.monthly_count = 0;
        t.daily_count = 0;
        t.service = setInterval(function () {
                t.tick2++;
                if (t.tick2 >= t.tick_interval) {
                    t.tick2 = 0;
                    t.tick++;
                    t.onservice && t.onservice(t.tick);
                }
            }, 1000);
        }

    setupEventHandlers() {
        this.resourceMonitor.on('memory-warning', (usage) => {
            this.logger.warn({ usage }, 'Memory usage warning');
            this.emit('resource-warning', { type: 'memory', usage });
        });

        this.resourceMonitor.on('memory-critical', (usage) => {
            this.logger.error({ usage }, 'Critical memory usage');
            this.emit('resource-critical', { type: 'memory', usage });
            // Initiate graceful shutdown
            this.gracefulShutdown('memory-critical');
        });

        // Handle uncaught errors to prevent instance crashes
        process.on('uncaughtException', (error) => {
            this.logger.error({ error }, 'Uncaught exception');
            this.emit('error', error);
            this.gracefulShutdown('uncaught-exception');
        });

        process.on('unhandledRejection', (reason, promise) => {
            this.logger.error({ reason, promise }, 'Unhandled promise rejection');
            this.emit('error', reason);
        });
    }

    async initialize() {
        try {
            this.logger.info('Initializing WhatsApp instance');
            this.state = 'INITIALIZING';

            // Create Redis client with timeout
            await this.createRedisConnection();

            // Initialize auth state - CRITICAL: Clean slate for pairing
            await this.initializeAuthState();

            // Create socket with timeout
            await this.createSocket();

            // Start resource monitoring
            this.resourceMonitor.start();

            this.logger.info('WhatsApp instance initialized successfully');
            this.state = 'INITIALIZED';
            this.emit('initialized');

        } catch (error) {
            this.logger.error({ error }, 'Failed to initialize WhatsApp instance');
            this.state = 'ERROR';
            this.emit('error', error);
            throw error;
        }
    }

    wait(ms, reason) {
        let t = this;
    // publish event
        t.PUB('wait', { content: { value: ms, reason: reason || 'wait' } });
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async saveMessageToDatabase(msg, isDeleted = false) {
        var t = this;
        try {
            var number = await t.db.read('db2/tbl_number').where('phonenumber', t.phone).promise();
            if (!number) return;

            var chat = await t.db.read('db2/tbl_chat').id(msg.key.remoteJid).where('numberid', number.id).promise();

            if (!chat) {
                chat = {};
                chat.id = UID();
                chat.numberid = number.id;
                chat.value = msg.key.remoteJid;
                chat.displayname = msg.pushName || '';
                chat.dtcreated = NOW;
                await t.db.insert('db2/tbl_chat', chat).promise();
            }

            var message = {};
            message.id = msg.key.id;
            message.chatid = chat.id;
            
            const messageType = Object.keys(msg.message || {})[0] || 'unknown';
            message.type = messageType;
            message.value = msg.message?.[messageType]?.text || msg.message?.[messageType]?.caption || '';
            message.caption = msg.message?.[messageType]?.caption || '';
            message.isviewonce = false;
            message.dtcreated = NOW;
            message.kind = isDeleted ? 'deleted' : 'received';
            message.isgroup = msg.key.remoteJid.indexOf('@g.us') !== -1;
            
            await t.db.insert('db2/tbl_message', message).promise();
            await t.db.update('db2/tbl_chat', { '+unread': 1, '+msgcount': 1 }).id(chat.id).promise();
        } catch (err) {
            console.error('Error saving message to database:', err);
        }
    }
    PUB(topic, obj, broker) {
         var t = this;
        obj.env = t.Worker.data;
        obj.topic = topic;
        console.log('PUB: ' + topic, obj.content);
        t.send(obj);
    }

    async refresh_plans() {
        let t = this;
        try {
            let order = t.order;
            if (!t.plan && t.number && t.number.plans) {
                t.plans = t.number.plans.split(',');
                let plans = await t.db.find('tbl_plan').in('id', t.plans).promise();
                t.plan = plans.findItem('id', 'elite') || plans.findItem('id', 'pro') || plans.findItem('id', 'standard') || plans.findItem('id', 'starter') || plans.findItem('id', 'free');
            }

            if (!t.order && t.plan) {
                t.order = await t.db.read('tbl_order').where('ispaid', true).where('expired=FALSE').where('planid', t.plan.id).where('numberid', t.number.id).promise();
            }

            if (t.plan && t.plan.id == 'free') {
                order = {};
                order.id = UID();
                order.planid = 'free';
                order.numberid = t.number.id;
                order.userid = t.number.userid;
                order.expire = order.dtend = NOW.add('7 days').format('dd-MM-yyyy');
                order.dtcreated = NOW;
                order.ispaid = true;
                order.date = order.dtstart = NOW.format('dd-MM-yyyy');
                await t.db.insert('tbl_order', order).promise();
                t.order = order;
            }

            t.refresh_days();
            t.refresh_limits();
        } catch (err) {
            console.error('Error refreshing plans:', err);
        }
    }

    refresh_days(key) {
        let t = this;
        return new Promise(async function (resolve) {
            try {
                let duration = t.plan && t.plan.id == 'free' ? 7 : 30;
                t.monthly_count = 0;
                t.daily_count = 0;

                if (t.order) {
                    for (var i = 0; i < duration; i++) {
                        let ts = t.order.ts || t.order.dtcreated;
                        let id = ts.add(i + ' days').format('dd-MM-yyyy');
                        let reqs = await t.db.find('tbl_request').where('numberid', t.number.id).where('date', id).promise();
                        t.monthly_count += reqs.length;
                        if (id == NOW.format('dd-MM-yyyy'))
                            t.daily_count = reqs.length;
                        t.days[id] = reqs || [];
                    }
                }
                resolve(key ? t.days[key] : t.days);
            } catch (err) {
                console.error('Error refreshing days:', err);
                resolve({});
            }
        });
    }

    async usage($, t) {
        try {
            var number = t.number;
            var data = {};
            data.id = UID();
            data.numberid = number.id;
            data.userid = number.userid;
            data.apikey = $.query.apikey;
            data.date = NOW.format('dd-MM-yyyy');
            data.ip = $.ip;
            data.ua = $.ua;
            data.status = 'pending';
            data.dtcreated = NOW;
            t.db.insert('tbl_request', data).callback(NOOP);
        } catch (err) {
            console.error('Error tracking usage:', err);
        }
    }

    async refresh_limits() {
      let t = this;
        try {
            if (t.plan && t.monthly_count >= t.plan.maxlimit) {
                t.is_maxlimit = true;
            }
            var key = NOW.format('dd-MM-yyyy');
            let reqs = t.days[key];

            if (t.plan && reqs && reqs.length >= t.plan.limit) {
                t.is_limit = true;
            }
        } catch (err) {
            console.error('Error refreshing limits:', err);
        }
    }

    async ask(number, chatid, content, type, isgroup, istag, user, group) {
         var t = this;
        const obj = {
            content: content,
            number: number,
            chatid: chatid,
            type: type,
            isgroup: isgroup,
            istag: istag,
            from: user,
            group: group
        };
        if (t.origin == 'zapwize') {
            t.ws_send(obj);

        }

        t.emit('ask', obj);
    }

    async send_message(data) {
        if (!data.chatid.includes('@')) {
            data.chatid = data.chatid.isPhone?.() ? data.chatid + '@s.whatsapp.net' : data.chatid + '@g.us';
        }

        const options = {};
        if (data.quoted) {
            options.quoted = data.quoted;
        }

        await this.socket.sendMessage(data.chatid, { text: data.content }, options);
    }

    async send_file(data) {
        if (!data.chatid.includes('@')) {
            data.chatid = data.chatid.isPhone?.() ? data.chatid + '@s.whatsapp.net' : data.chatid + '@g.us';
        }

        
        let filename;
        
        const caption = data.caption || '';
        let mimetype = 'application/octet-stream'; 
        let buffer;

        if (data.type === 'url') {
            // Download using global DOWNLOAD helper
            let fs = F.Fs;
            data.ext = U.getExtension(data.url);
            filename = `file_${Date.now()}.` + (data.ext || '');
            
            mimetype = U.getContentType(filename);
            await new Promise((resolve, reject) => {
                DOWNLOAD(data.url, PATH.temp(filename), function(err, response) {
                    if (err) return reject(err);
                    buffer = fs.readFileSync(PATH.temp(filename));
                    fs.unlinkSync(PATH.temp(filename)); // clean up
                    resolve();
                });
            });
        } else if (data.type === 'base64') {
            const base64 = data.content.replace(/^data:.*?base64,/, '');
            buffer = Buffer.from(base64, 'base64');
        } else {
            throw new Error('Invalid data type. Use "url" or "base64".');
        }

        const msg = {
            document: buffer,
            fileName: filename,
            mimetype: mimetype,
            caption: caption
        };

        await this.socket.sendMessage(data.chatid, msg);
    };


    async message(msg, ctrl) {
        var t = this;
        var output = { reqid: msg.reqid || UID(), state: t.state };
        var topic = msg.topic;
        switch (topic) {
            case 'state':
                var state = t.whatsapp && await t.whatsapp.getState();
                output.content = state;
                break;
            case 'restart':
            case 'logout':
                t.whatsapp && await t.restartInstance();
                output.content = 'OK';
                break;
            case 'reset':
                t.whatsapp && await t.resetInstance();
                output.content = 'OK';
                break;
            case 'ping':
            case 'test':
                output.content = 'OK';
                break;
            case 'logs':
                output.content = t.logs;
                break;
            case 'config':
                output.content = t.Data;
                break;
            case 'memory':
                output.content = t.memorize.data;
                break;
            case 'memory_refresh':
                t.memory_refresh(msg.content);
                output.content = 'OK';
                break;
        }

        !ctrl && t.send(output);
        ctrl && !ctrl.ws && ctrl.json(output);
        ctrl && ctrl.ws && ctrl.client.send(output);
    }

    save_file(data) {
        var obj = {};
        obj.name = GUID(35) + data.ext;
        obj.file = data.content;
        var fs = FILESTORAGE(data.number);

        var id = data.custom.dp;
        fs.save(id || UID(), obj.name, obj.file.base64ToBuffer(), function (err, meta) {
            meta.url = '/' + data.number + '/download/{0}.{1}'.format(meta.id.sign(CONF.salt), meta.ext);
            //callback && callback(meta);
        }, data.custom, CONF.ttl);
    }

    onservice(tick) {
        var t = this;
    // we check some metrics about the remote browser cl.baseurl + 'metrics/total' + cl.token
        t.Worker = MEMORIZE(t.phone);

        if (tick % 30 == 0) {
            t.number && t.refresh_plans();
        }

        if (tick % 5 == 0) {
            t.number && t.refresh_plans();
        }

        console.log('Instance: ' + t.phone + ' - ' + t.state);
        t.refresh_days();
        t.refresh_limits();
    }

    async init () {
        let t = this;
        try {
            var number = await t.db.read('db2/tbl_number').where('phonenumber', t.phone).promise();
            
            if (!number) {
                number = {};
                number.id = UID();
                number.phonenumber = t.phone;
                number.url = 'ws://' + t.ip + ':' + t.port;
                number.baseurl = 'http://' + t.ip + ':' + t.port;
                number.token = t.Data.token;
                number.dtcreated = NOW;
                await t.db.insert('db2/tbl_number', number).promise();
            } else {
                let upd = {};
                upd.url = 'ws://' + t.ip + ':' + t.port;
                upd.baseurl = 'http://' + t.ip + ':' + t.port;
                upd.token = t.Data.token;
                upd.dtupdated = NOW;
                await t.db.update('db2/tbl_number', upd).where('phonenumber', t.phone).promise();
                number = await t.db.read('db2/tbl_number').where('phonenumber', t.phone).promise();
            }

            t.number = number;
            t.refresh_plans();

            t.resetInstance = async function () {
                try {
                    t.pairingCodeRequested = false;
                    t.PUB('instance_restarted', { content: true });
                    await t.wait(5000, 'restarting instance');
                } catch (err) {
                    console.error('Error restarting instance:', err);
                }
            };
            
            t.restartInstance = async function () {
                try {
                    t.pairingCodeRequested = false;
                    t.PUB('instance_reset', { content: true });
                    await t.wait(2000, 'resetting instance');
                } catch (err) {
                    console.error('Error resetting instance:', err);
                }
            };

            setTimeout(function () {
                console.log('Initializing whatsapp: ' + t.id);
                t.logs.push({ name: 'instance_initializing', content: 'ID:' + t.id });
            }, 500);
            
        } catch (err) {
            console.error('Error initializing instance:', err);
            t.logs.push({ name: 'instance_error', content: err.message });
        }

    }

    die() {
         var t = this;
    if (t.service) {
        clearInterval(t.service);
    }
   
    }

    get_code() {
        var t = this;
        if (t.pairingCodeEnabled && !t.pairingCodeRequested) {
            t.PUB('code', { env: t.Worker.data, content: t.code });
        } else {
            t.PUB('qr', { env: t.Worker.data, content: t.qrcode });
        }
    }

    ws_send(obj) {
        var t = this;
        for (var key in t.ws_clients) {
            var client = t.ws_clients[key];
            if (client && client.send) {
                try {
                    client.send(obj);
                } catch (err) {
                    console.error('Error sending to websocket client:', err);
                    delete t.ws_clients[key];
                }
            }
        }
    }

    notify(obj) {
        var t = this;
        if (CONF.notify) {
            RESTBuilder.POST(CONF.notify.format(obj.topic), { title: obj.title }).keepalive().callback(NOOP);
        }
    }

    async save_revoked(data) {
        var t = this;
        try {
            var content = data.content;
            var env = data.env;
            var user = content.user;
            var group = content.group;
            var number = await t.db.read('db2/tbl_number').where('phonenumber', env.phone).promise();
            var chat = await t.db.read('db2/tbl_chat').id(user.number).where('numberid', number.id).promise();

            if (!chat) {
                chat = {};
                chat.id = UID();
                chat.numberid = number.id;
                chat.value = user.phone;
                chat.displayname = user.pushname;
                chat.dtcreated = NOW;
                await t.db.insert('db2/tbl_chat', chat).promise();
            }
            
            var message = {};
            message.id = UID();
            message.chatid = chat.id;
            message.type = content.type;
            message.value = message.content = content.content;
            message.caption = content.caption;
            message.isviewonce = false;
            message.dtcreated = NOW;
            message.kind = content.type == 'edited' ? 'edited' : 'revoked';
            await t.db.insert('db2/tbl_message', message).promise();
            await t.db.update('db2/tbl_chat', { '+unread': 1, '+msgcount': 1 }).id(chat.id).promise();
            
            // send push notification
            var obj = {};
            obj.topic = 'revoked-' + t.phone;
            obj.title = user.pushname;
            t.notify(obj);
        } catch (err) {
            console.error('Error saving revoked message:', err);
        }
    }

    laststate() {
        var t = this;
        var len = t.logs.length;
        return t.logs[len - 1];
    }

    send(obj) {
        var t = this;
        if (!obj.env)
            obj.env = t.Data;
        obj.env.phone = t.phone;
        obj.type = 'event';
        if (t.Data.webhook) {
            RESTBuilder.POST(t.Data.webhook, obj)
                .header('x-token', t.Data.token)
                .header('token', t.Data.token)
                .callback(NOOP);
        }
    }

    memory_refresh(body, callback) {
         var t = this;

        if (body) {
            for (var key in body)
                t.Worker.data[key] = body[key];
        }

        t.Worker.save();
        t.Worker = MEMORIZE(t.phone);
        callback && callback();

    }

    async createRedisConnection() {
        const redisManager = new RedisManager({ url: this.config.redisUrl });
        this.redisClient = await redisManager.getClient(this.id);

        this.store = new RedisStore({
            redisConnection: this.redisClient,
            prefix: this.phone,
            logger: this.logger.child({ component: 'store' }),
            maxCacheSize: this.config.maxCacheSize || 1000,
        });
    }

    async initializeAuthState() {
        const authDir = `${this.config.authDir || 'databases'}/${this.phone}`;

        // CRITICAL: If using pairing code and no existing session, ensure clean auth state
        if (this.usePairingCode) {
            const fs = require('fs');
            const path = require('path');

            // Check if this is a fresh pairing attempt
            const credsPath = path.join(authDir, 'creds.json');
            if (!fs.existsSync(credsPath) || this.config.forceFreshPairing) {
                // Ensure clean directory for fresh pairing
                if (fs.existsSync(authDir) && this.config.forceFreshPairing) {
                    fs.rmSync(authDir, { recursive: true, force: true });
                    this.logger.info('Cleaned auth directory for fresh pairing');
                }
            }
        }

        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        this.authState = { state, saveCreds };

        this.logger.debug({
            hasRegistration: !!state.creds?.registration,
            hasMeData: !!state.creds?.me,
            isRegistered: !!state.creds?.registered
        }, 'Auth state initialized');

        this.init();
    }

    async createSocket() {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Socket creation timeout'));
        }, this.connectionTimeout);

        try {
            // Simplified socket configuration that works
            const socketConfig = {
                auth: this.authState.state,
                browser: ['Mac OS', 'Chrome', '119.0.0.0'], // Use working browser config
                logger: this.logger.child({ component: 'socket' }),
                printQRInTerminal: false,
                markOnlineOnConnect: true, // Changed to true like working script
                
                // Remove problematic options that cause issues
                // generateHighQualityLinkPreview: false,
                // syncFullHistory: false,
                // retryRequestDelayMs: 1000,
                // maxMsgRetryCount: 3,
                // connectTimeoutMs: 120000,
                // defaultQueryTimeoutMs: 120000,
                // keepAliveIntervalMs: 25000,
                // shouldIgnoreJid: () => false,
                // shouldSyncHistoryMessage: () => false,
                // transactionOpts: {
                //     maxCommitRetries: 5,
                //     delayBetweenTriesMs: 2000
                // }
            };

            this.socket = makeWASocket(socketConfig);
            this.setupSocketHandlers();

            clearTimeout(timeout);
            resolve();
        } catch (error) {
            clearTimeout(timeout);
            reject(error);
        }
    });
}


    setupSocketHandlers() {
        if (!this.socket) return;

        // Bind store to socket events
        this.store.bind(this.socket.ev);

        // Credentials update
        this.socket.ev.on('creds.update', this.authState.saveCreds);

        // Connection updates with proper error handling
        this.socket.ev.on('connection.update', this.handleConnectionUpdate.bind(this));

        // Message handling with queue
        this.socket.ev.on('messages.upsert', this.handleMessages.bind(this));
        this.socket.ev.on('messages.delete', this.handleMessageDelete.bind(this));

        // Presence updates
        this.socket.ev.on('presence.update', this.handlePresenceUpdate.bind(this));

        // Chat updates
        this.socket.ev.on('chats.set', this.handleChatsSet.bind(this));
        this.socket.ev.on('chats.update', this.handleChatsUpdate.bind(this));
    }

    async handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    try {
        this.state = connection || 'UNKNOWN';
        this.lastHeartbeat = Date.now();

        this.logger.info({
            connection,
            state: this.state,
            hasQr: !!qr,
            usePairingCode: this.usePairingCode,
            pairingCodeRequested: this.pairingCodeRequested,
            isRegistered: !!this.authState.state.creds?.registered
        }, 'Connection update');

        if (connection === 'open') {
            this.reconnectAttempts = 0;
            this.pairingAttempts = 0;
            this.pairingCodeRequested = false;
            this.clearPairingCodeTimer();
            this.logger.info('WhatsApp connection established');
            this.emit('ready');

        } else if (connection === 'close') {
            await this.handleConnectionClose(lastDisconnect);

        } else if (connection === 'connecting') {
            this.logger.info('Connecting to WhatsApp...');
        }

        // Handle QR/Pairing code - simplified logic
        if (qr && this.usePairingCode && !this.pairingCodeRequested) {
            // Add delay like working script
            setTimeout(async () => {
                try {
                    await this.requestPairingCode();
                } catch (error) {
                    this.logger.error({ error }, 'Failed to request pairing code');
                }
            }, 2000);
        } else if (qr && !this.usePairingCode) {
            this.logger.info('QR code received');
            this.emit('qr', qr);
        }

    } catch (error) {
        this.logger.error({ error }, 'Error handling connection update');
        this.emit('error', error);
    }
}

    // CRITICAL: Enhanced phone number validation and formatting
    validateAndFormatPhoneNumber(phone) {
        if (!phone) {
            throw new Error('Phone number is required');
        }

        // Remove all non-digit characters
        let sanitized = phone.toString().replace(/[^0-9]/g, '');

        // Remove leading zeros but preserve country code structure
        sanitized = sanitized.replace(/^0+/, '');

        // Validate minimum length (must be at least 10 digits)
        if (sanitized.length < 10) {
            throw new Error(`Invalid phone number: too short (${sanitized.length} digits)`);
        }

        // Validate maximum length (international format shouldn't exceed 15 digits)
        if (sanitized.length > 15) {
            throw new Error(`Invalid phone number: too long (${sanitized.length} digits)`);
        }

        // Ensure it doesn't start with 1 unless it's a valid North American number
        if (sanitized.startsWith('1') && sanitized.length !== 11) {
            throw new Error('Invalid North American phone number format');
        }

        this.logger.debug({
            original: phone,
            sanitized: sanitized,
            length: sanitized.length
        }, 'Phone number validation');

        return sanitized;
    }

    async requestPairingCode() {
    try {
        if (!this.socket) {
            throw new Error('Socket not available for pairing code request');
        }

        if (this.pairingCodeRequested) {
            this.logger.warn('Pairing code already requested, skipping');
            return;
        }

        if (this.pairingAttempts >= this.maxPairingAttempts) {
            throw new Error(`Maximum pairing attempts (${this.maxPairingAttempts}) exceeded`);
        }

        // Check if already registered (like working script)
        if (this.authState?.state?.creds?.registered) {
            throw new Error('This instance is already registered. No pairing code can be generated.');
        }

        const sanitizedPhone = this.validateAndFormatPhoneNumber(this.phone);

        this.logger.info({
            phone: sanitizedPhone,
            originalPhone: this.phone,
            attempt: this.pairingAttempts + 1
        }, 'Requesting pairing code');

        this.clearPairingCodeTimer();
        this.pairingCodeRequested = true;
        this.pairingAttempts++;

        // Add delay like working script (10 seconds)
        this.logger.info('Waiting 10 seconds before requesting pairing code...');
        await new Promise(resolve => setTimeout(resolve, 10000));

        let pairingCode;
        try {
            pairingCode = await this.socket.requestPairingCode(sanitizedPhone);
        } catch (error) {
            this.pairingCodeRequested = false;
            this.logger.error({
                error: error.message,
                phone: sanitizedPhone,
                socketState: this.socket?.readyState
            }, 'Pairing code request failed');

            if (error.message.includes('bad-request') || error.message.includes('400')) {
                throw new Error(`Invalid phone number format: ${sanitizedPhone}. Please verify the number is correct and includes country code.`);
            }
            throw error;
        }

        if (!pairingCode) {
            this.pairingCodeRequested = false;
            throw new Error('Failed to generate pairing code - empty response');
        }

        this.currentPairingCode = pairingCode;

        // Format like working script
        const formattedCode = pairingCode.length === 8 ? 
            pairingCode.slice(0, 4) + '-' + pairingCode.slice(4) : 
            pairingCode;

        this.logger.info({
            pairingCode: formattedCode,
            phone: this.phone,
            sanitizedPhone,
            attempt: this.pairingAttempts,
            instructions: 'Enter this code in WhatsApp > Linked Devices > Link a Device'
        }, 'Pairing code generated successfully');

        // Emit pairing code event
        this.emit('pairing-code', {
            phone: this.phone,
            sanitizedPhone,
            code: formattedCode,
            rawCode: pairingCode,
            attempt: this.pairingAttempts,
            instructions: 'Open WhatsApp → Settings → Linked Devices → Link a Device → Enter this code'
        });

        // Set timer (2 minutes like original, but could be longer)
        this.pairingCodeTimer = setTimeout(() => {
            this.logger.warn({
                phone: this.phone,
                code: formattedCode,
                attempt: this.pairingAttempts
            }, 'Pairing code expired');

            this.currentPairingCode = null;
            this.pairingCodeRequested = false;

            this.emit('pairing-code-expired', {
                phone: this.phone,
                code: formattedCode,
                attempt: this.pairingAttempts
            });

        }, this.pairingCodeTimeout);

    } catch (error) {
        this.pairingCodeRequested = false;
        this.logger.error({
            error: error.message,
            phone: this.phone,
            attempt: this.pairingAttempts
        }, 'Failed to request pairing code');

        this.emit('pairing-code-error', {
            phone: this.phone,
            error: error.message,
            attempt: this.pairingAttempts
        });
        throw error;
    }
}


    clearPairingCodeTimer() {
        if (this.pairingCodeTimer) {
            clearTimeout(this.pairingCodeTimer);
            this.pairingCodeTimer = null;
        }
    }

    getCurrentPairingCode() {
        return this.currentPairingCode;
    }

    isPairingCodeActive() {
        return this.currentPairingCode !== null && this.pairingCodeRequested;
    }

    async refreshPairingCode() {
        if (!this.usePairingCode) {
            throw new Error('Pairing code is not enabled for this instance');
        }

        if (this.state === 'open') {
            throw new Error('Instance is already connected');
        }

        // Reset state for fresh attempt
        this.clearPairingCodeTimer();
        this.currentPairingCode = null;
        this.pairingCodeRequested = false;

        await this.requestPairingCode();
    }

    async handleConnectionClose(lastDisconnect) {
    const reason = lastDisconnect?.error?.output?.statusCode;
    const shouldReconnect = reason !== DisconnectReason.loggedOut;

    // Clear pairing code on certain errors
    if (reason === DisconnectReason.loggedOut || reason === 401 || reason === 403) {
        this.clearPairingCodeTimer();
        this.currentPairingCode = null;
        this.pairingCodeRequested = false;
        this.pairingAttempts = 0;
    }

    this.logger.warn({
        reason,
        shouldReconnect,
        isPairingActive: this.isPairingCodeActive(),
        pairingAttempts: this.pairingAttempts
    }, 'Connection closed');

    if (reason === DisconnectReason.loggedOut) {
        this.logger.info('Device logged out');
        this.emit('logged-out');
        return;
    }

    // Special handling for code 515 (blocked session)
    if (reason === 515) {
        this.reconnectAttempts++;
        
        this.logger.info({
            attempt: this.reconnectAttempts,
            delay: 5000 // Fixed 5 second delay like working script
        }, 'Attempting reconnection');

        setTimeout(async () => {
            try {
                await this.createSocket();
            } catch (error) {
                this.logger.error({ error }, 'Reconnection failed');
                this.emit('error', error);
            }
        }, 5000);
        return
    }

    // Simple reconnection logic like working script
    if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts && !this.isShuttingDown) {
        this.reconnectAttempts++;
        
        this.logger.info({
            attempt: this.reconnectAttempts,
            delay: 5000 // Fixed 5 second delay like working script
        }, 'Attempting reconnection');

        setTimeout(async () => {
            try {
                await this.createSocket();
            } catch (error) {
                this.logger.error({ error }, 'Reconnection failed');
                this.emit('error', error);
            }
        }, 5000);
    } else {
        this.logger.error('Max reconnection attempts reached or shutting down');
        this.emit('max-reconnect-attempts');
    }
}
    async handleMessages(messageUpdate) {
        if (!messageUpdate || messageUpdate.type !== 'notify') return;

        try {
            // Add messages to queue to handle bursts
            for (const message of messageUpdate.messages) {
                if (this.messageQueue.length >= this.maxQueueSize) {
                    this.logger.warn('Message queue full, dropping message');
                    continue;
                }
                this.messageQueue.push(message);
            }

            // Process queue if not already processing
            if (!this.processingQueue) {
                this.processMessageQueue();
            }

        } catch (error) {
            this.logger.error({ error }, 'Error handling messages');
        }
    }

    async processMessageQueue() {
        this.processingQueue = true;

        while (this.messageQueue.length > 0 && !this.isShuttingDown) {
            const message = this.messageQueue.shift();

            try {
                await this.processMessage(message);
            } catch (error) {
                this.logger.error({ error, messageId: message.key?.id }, 'Error processing message');
            }
        }

        this.processingQueue = false;
    }

    async processMessage(message) {
        // Auto-read messages if enabled
        if (this.config.autoRead && message.key && !message.key.fromMe) {
            try {
                await this.socket.readMessages([message.key]);
            } catch (error) {
                this.logger.warn({ error }, 'Failed to mark message as read');
            }
        }

        console.log('📩 Received message:', getContentType(message.message));

        FUNC.send_seen(message, this.socket);
        FUNC.handle_status(message, this, this.socket);
        FUNC.handle_voice(message, this, this.socket);
        FUNC.handle_textonly(message, this, this.socket);
        FUNC.handle_media(message, this, this.socket);
        FUNC.handle_image(message, this, this.socket);



        // Emit message event
        this.emit('message', message);
    }

    async handleMessageDelete(deleteUpdate) {
        try {
            this.emit('message-delete', deleteUpdate);
        } catch (error) {
            this.logger.error({ error }, 'Error handling message delete');
        }
    }

    async handlePresenceUpdate(presenceUpdate) {
        try {
            this.emit('presence-update', presenceUpdate);
        } catch (error) {
            this.logger.error({ error }, 'Error handling presence update');
        }
    }

    async handleChatsSet(chatUpdate) {
        try {
            this.emit('chats-set', chatUpdate);
        } catch (error) {
            this.logger.error({ error }, 'Error handling chats set');
        }
    }

    async handleChatsUpdate(chatUpdate) {
        try {
            this.emit('chats-update', chatUpdate);
        } catch (error) {
            this.logger.error({ error }, 'Error handling chats update');
        }
    }

    async sendMessage(jid, content, options = {}) {
        if (!this.socket || this.state !== 'open') {
            throw new Error('WhatsApp is not connected');
        }

        try {
            const result = await this.socket.sendMessage(jid, content, options);
            this.logger.debug({ jid, contentType: typeof content }, 'Message sent');
            return result;
        } catch (error) {
            this.logger.error({ error, jid }, 'Failed to send message');
            throw error;
        }
    }

    startHealthCheck() {
        this.healthCheckTimer = setInterval(() => {
            const now = Date.now();
            const timeSinceHeartbeat = now - this.lastHeartbeat;

            if (timeSinceHeartbeat > this.healthCheckInterval * 2) {
                this.logger.warn({ timeSinceHeartbeat }, 'Health check failed - no heartbeat');
                this.emit('health-check-failed');
            }

            // Update heartbeat
            this.lastHeartbeat = now;
            this.emit('heartbeat');

        }, this.healthCheckInterval);
    }

    async gracefulShutdown(reason = 'unknown') {
        if (this.isShuttingDown) return;

        this.isShuttingDown = true;
        this.logger.info({ reason }, 'Starting graceful shutdown');

        try {
            // Clear pairing code timer
            this.clearPairingCodeTimer();
            this.currentPairingCode = null;
            this.pairingCodeRequested = false;

            // Stop accepting new messages
            this.removeAllListeners('message');

            // Process remaining messages in queue
            while (this.messageQueue.length > 0) {
                const message = this.messageQueue.shift();
                try {
                    await this.processMessage(message);
                } catch (error) {
                    this.logger.error({ error }, 'Error processing message during shutdown');
                }
            }

            // Stop health check
            if (this.healthCheckTimer) {
                clearInterval(this.healthCheckTimer);
            }

            // Stop resource monitoring
            this.resourceMonitor.stop();

            // Close socket
            if (this.socket) {
                this.socket.end();
                this.socket = null;
            }

            // Close Redis connection
            if (this.redisClient) {
                await this.redisClient.quit();
                this.redisClient = null;
            }

            this.state = 'SHUTDOWN';
            this.logger.info('Graceful shutdown completed');
            this.emit('shutdown');

        } catch (error) {
            this.logger.error({ error }, 'Error during graceful shutdown');
            this.emit('error', error);
        }
    }

    getHealth() {
        return {
            id: this.id,
            phone: this.phone,
            state: this.state,
            reconnectAttempts: this.reconnectAttempts,
            queueSize: this.messageQueue.length,
            lastHeartbeat: this.lastHeartbeat,
            uptime: Date.now() - this.startTime || 0,
            memory: process.memoryUsage(),
            usePairingCode: this.usePairingCode,
            isPairingCodeActive: this.isPairingCodeActive(),
            currentPairingCode: this.currentPairingCode,
            pairingAttempts: this.pairingAttempts,
            pairingCodeRequested: this.pairingCodeRequested,
        };
    }
}

// Session manager with clustering and load balancing
class WhatsAppSessionManager extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = config;
        this.instances = new Map();
        this.logger = createLogger('session-manager');
        this.maxInstances = config.maxInstances || 1000;
        this.instancesPerWorker = config.instancesPerWorker || 100;
        this.workerPool = [];
        this.roundRobinIndex = 0;

        // Health monitoring
        this.healthCheckInterval = config.healthCheckInterval || 30000;
        this.startHealthMonitoring();

        // Setup Routes
        this.setupRoutes();
    }

    async createInstance(phone, config = {}) {
        if (this.instances.has(phone)) {
            throw new Error(`Instance for ${phone} already exists`);
        }

        if (this.instances.size >= this.maxInstances) {
            throw new Error('Maximum number of instances reached');
        }

        try {
            const instanceConfig = { ...this.config, ...config };
            const instance = new WhatsAppInstance(phone, instanceConfig);

            // Setup instance event handlers
            this.setupInstanceHandlers(instance);

            // Initialize instance
            await instance.initialize();

            // Store instance
            this.instances.set(phone, instance);

            this.logger.info({ phone, instanceId: instance.id }, 'Instance created successfully');
            this.emit('instance-created', { phone, instance });

            return instance;

        } catch (error) {
            this.logger.error({ phone, error }, 'Failed to create instance');
            throw error;
        }
    }

    async createInstanceWithPairingCode(phone, config = {}) {
        const pairingConfig = {
            ...config,
            usePairingCode: true,
            printQRInTerminal: false
        };

        return this.createInstance(phone, pairingConfig);
    }

    setupInstanceHandlers(instance) {
        instance.on('error', (error) => {
            this.logger.error({ instanceId: instance.id, phone: instance.phone, error }, 'Instance error');
            this.emit('instance-error', { instance, error });
        });

        instance.on('pairing-code', (data) => {
            this.logger.info({ instanceId: instance.id, phone: data.phone, code: data.code }, 'Pairing code generated');
            this.emit('pairing-code', data);
        });

        instance.on('pairing-code-expired', (data) => {
            this.logger.warn({ instanceId: instance.id, phone: data.phone }, 'Pairing code expired');
            this.emit('pairing-code-expired', data);
        });

        instance.on('pairing-code-error', (data) => {
            this.logger.error({ instanceId: instance.id, phone: data.phone, error: data.error }, 'Pairing code error');
            this.emit('pairing-code-error', data);
        });

        instance.on('resource-critical', async (data) => {
            this.logger.warn({ instanceId: instance.id, phone: instance.phone, data }, 'Instance resource critical');
            // Remove instance to prevent system instability
            await this.removeInstance(instance.phone, 'resource-critical');
        });

        instance.on('max-reconnect-attempts', async () => {
            this.logger.warn({ instanceId: instance.id, phone: instance.phone }, 'Instance max reconnect attempts reached');
            await this.removeInstance(instance.phone, 'max-reconnect-attempts');
        });

        instance.on('shutdown', () => {
            this.logger.info({ instanceId: instance.id, phone: instance.phone }, 'Instance shutdown');
            this.instances.delete(instance.phone);
        });
    }

    async removeInstance(phone, reason = 'manual') {
        const instance = this.instances.get(phone);
        if (!instance) {
            throw new Error(`Instance for ${phone} not found`);
        }

        try {
            await instance.gracefulShutdown(reason);
            this.instances.delete(phone);

            this.logger.info({ phone, reason }, 'Instance removed successfully');
            this.emit('instance-removed', { phone, reason });

        } catch (error) {
            this.logger.error({ phone, error }, 'Error removing instance');
            throw error;
        }
    }

    getInstance(phone) {
        return this.instances.get(phone);
    }

    getAllInstances() {
        return Array.from(this.instances.values());
    }

    async refreshPairingCode(phone) {
        const instance = this.getInstance(phone);
        if (!instance) {
            throw new Error(`Instance for ${phone} not found`);
        }

        return instance.refreshPairingCode();
    }

    getPairingCode(phone) {
        const instance = this.getInstance(phone);
        if (!instance) {
            throw new Error(`Instance for ${phone} not found`);
        }

        return instance.getCurrentPairingCode();
    }

    getHealthStatus() {
        const instances = this.getAllInstances();
        const health = instances.map(instance => instance.getHealth());

        return {
            totalInstances: instances.length,
            maxInstances: this.maxInstances,
            healthyInstances: health.filter(h => h.state === 'open').length,
            pairingCodeInstances: health.filter(h => h.usePairingCode).length,
            activePairingCodes: health.filter(h => h.isPairingCodeActive).length,
            instances: health,
            systemMemory: process.memoryUsage(),
            uptime: process.uptime(),
        };
    }

    startHealthMonitoring() {
        this.healthTimer = setInterval(() => {
            this.performHealthCheck();
        }, this.healthCheckInterval);
    }

    async performHealthCheck() {
        const instances = this.getAllInstances();
        const unhealthyInstances = [];

        for (const instance of instances) {
            const health = instance.getHealth();
            const timeSinceHeartbeat = Date.now() - health.lastHeartbeat;

            if (timeSinceHeartbeat > this.healthCheckInterval * 3) {
                unhealthyInstances.push(instance);
            }
        }

        // Remove unhealthy instances
        for (const instance of unhealthyInstances) {
            this.logger.warn({ instanceId: instance.id, phone: instance.phone }, 'Removing unhealthy instance');
            await this.removeInstance(instance.phone, 'health-check-failed');
        }

        this.emit('health-check-completed', {
            total: instances.length,
            unhealthy: unhealthyInstances.length,
        });
    }

    async gracefulShutdown() {
        this.logger.info('Starting graceful shutdown of all instances');

        if (this.healthTimer) {
            clearInterval(this.healthTimer);
        }

        const instances = this.getAllInstances();
        const shutdownPromises = instances.map(instance =>
            instance.gracefulShutdown('manager-shutdown').catch(error =>
                this.logger.error({ error, instanceId: instance.id }, 'Error during instance shutdown')
            )
        );

        await Promise.allSettled(shutdownPromises);
        this.instances.clear();

        this.logger.info('All instances shutdown completed');
    }

    setupRoutes() {
        let inst = this;
            // Setup routes
            ROUTE('+POST /api/config/{phone}/', function (phone) {
                let t = inst.instances.get(phone);
                var self = this;
                if (!t) {
                    self.throw404();
                    return;
                }
                var body = self.body;
                t.memory_refresh(body, function () {
                    self.success();
                });
            });

            ROUTE('+GET /api/config/{phone}/', function (phone) {
                let t = inst.instances.get(phone);
                var self = this;
                if (!t) {
                    self.throw404();
                    return;
                }
                self.json(t.Data);
            });

            ROUTE('+POST /api/rpc/{phone}/', function (phone) {
                let t = inst.instances.get(phone);
                var self = this;
                if (!t) {
                    self.throw404();
                    return;
                }
                var payload = self.body;
                self.ws = false;
                t.message(payload, self);
            }); 

            ROUTE('+POST /api/send/{phone}/', function (phone) {
                let t = inst.instances.get(phone);
                var self = this;
                if (!t) {
                    self.throw404();
                    return;
                }
                if (t.state == 'open') {
                    t.sendMessage(self.body);
                    t.usage(self);
                }

                if (t.state == 'open')
                    self.success();
                else
                    self.json({ success: false, state: t.state });
            });

            ROUTE('+POST /api/media/{phone}/', function () {
                let t = inst.instances.get(this.phone);
                var self = this;
                if (!t) {
                    self.throw404();
                    return;
                }
                if (t.state == 'open') {
                    t.send_file(self.body);
                    t.usage(self);
                }


                if (t.state == 'open')
                    self.success();
                else
                    self.json({ success: false, state: t.state });

            });

            // Websocket server
            ROUTE('+SOCKET /api/ws/{phone}/', function (phone) {
                let t = inst.instances.get(phone);
                var self = this;
                var socket = self;
                if (!t) {
                    self.throw404();
                    return;
                }
                self.ws = true;
                t.ws = socket;
                self.autodestroy();
                
                socket.on('open', function (client) {
                    client.phone = t.phone;
                    t.ws_clients[client.id] = client;

                    var timeout = setTimeout(function () {
                        if (t.state == 'open') {
                            client.send({ type: 'ready' });
                        } else {
                            for (var log of t.logs) {
                                if (log.name == 'whatsapp_ready')
                                    client.send({ type: 'ready' });
                            }
                        }
                        clearTimeout(timeout);
                    }, 2000);
                });
                
                socket.on('message', function (client, msg) {
                    if (msg && msg.topic) {
                        self.client = client;
                        t.message(msg, self);
                    }

                    if (msg && msg.type) {
                        switch (msg.type) {
                            case 'text':
                                if (t.state == 'open') {
                                    t.send_message(msg);
                                }
                                break;
                            case 'file':
                                if (t.state == 'open') {
                                    t.send_file(msg);
                                }
                                break;
                        }
                        if (t.state == 'open')
                            client.send({ success: true });
                        else
                            client.send({ success: false, state: t.state });
                    }
                });
                
                socket.on('disconnect', function (client) {
                    console.log('Client disconnected:', client.id);
                    delete t.ws_clients[client.id];
                });
            });

    }
}

// Export classes for main usage

MAIN.WhatsAppInstance = WhatsAppInstance;
MAIN.WhatsAppSessionManager = WhatsAppSessionManager;
MAIN.ResourceMonitor = ResourceMonitor;
MAIN.CircuitBreaker = CircuitBreaker;
MAIN.RedisManager = RedisManager;
