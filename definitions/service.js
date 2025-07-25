const { makeWASocket, useMultiFileAuthState, Browsers, getContentType,    
 DisconnectReason } = require('baileys');
const { RedisStore } = require('baileys-redis-store');
const { createClient } = require('redis');
const pino = require('pino');
const EventEmitter = require('events');
const os = require('os');

let client = createClient({ url: CONF.redisUrl });

client.on('error', (err) => {
    console.error(`Redis error for ${F.id}:`, err);
});

client.on('reconnecting', () => {
    console.log(`Redis reconnecting for ${F.id}`);
});

if  (!MAIN.redis)
    MAIN.redis = client;

MAIN.redis.connect();

// In-memory ACK listener registry to avoid duplicate hooks
const ACK_LISTENERS = new Map();

if (!MAIN.instances) {
    MAIN.instances = new Map();
}

if (!MAIN.wsclients) {
    MAIN.wsclients = new Map();
}

if (!MAIN.clusters) {
    MAIN.clusters = new Map();
}
// Cluster-aware instance lookup helper
FUNC.findInstanceCluster = async (phone) => {
    const local = MAIN.instances.get(phone);
    if (local) return { instance: local, local: true, clusterId: F.id };

    const global = await MAIN.sessionManager.getInstanceGlobally(phone);
    return global ? { clusterId: global.clusterId, local: false } : null;
};

const silentLogger = {
    info: NOOP,
    warn: NOOP,
    error: NOOP,
    trace: NOOP,
    debug: console.log,
    child: () => silentLogger
};

// Produc   tion-grade logger with levels and structured logging
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
            memoryThreshold: config.memoryThreshold || 200 * 1024 * 1024, // 100MB per instance
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

        this.MAX_RETRIES = 3;
        this.RETRY_DELAY = 1000; // 1 second
        this.CRITICAL_TIMEOUT = 30000; // 30 seconds
        this.processingQueue = false;
        this.isShuttingDown = false;
        this.processedMessages = new Set(); // Deduplication
        this.failedMessages = new Map(); // Track failures
        this.setupEventHandlers();
        this.startHealthCheck();

        // Custom
        let t = this;
        t.db = DB();
        let filename = PATH.databases('memorize_' + phone + '.json');
        // check if memorize file exists, if not create it
        if (!Total.Fs.existsSync(filename)) {
            Total.Fs.writeFileSync(filename, JSON.stringify(FUNC.getFormattedData(phone, CONF.baseurl, config.managerid), null, 2));
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
        t.cluterid = data.clusterid;
        t.managerid = data.managerid || config.managerid;
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


    async saveToDatabase(msg) {
        var t = this;
        try {
            var number = await t.db.read('db2/tbl_number').where('phonenumber', t.phone).promise();
            if (!number) return;

            var chat = await t.db.read('db2/tbl_chat').where('chatid', msg.chatid).where('numberid', number.id).promise();

            if (!chat) {
                chat = {};
                chat.id = UID();
                // chat.photo = await this.socket.profilePictureUrl(msg.chatid, 'preview');
                chat.chatid = msg.chatid;
                chat.numberid = number.id;
                chat.value = msg.number;
                chat.displayname = msg.from.pushname || '';
                chat.isgroup = msg.isgroup;
                chat.dtcreated = NOW;
                chat.lastmessage = msg.id;
                await t.db.insert('db2/tbl_chat', chat).promise();
            } else {
                // chat.photo = await this.socket.profilePictureUrl(msg.chatid, 'preview');
                chat.lastmessage = msg.id;
                chat.displayname = msg.from.pushname || '';
                chat.dtupdated = NOW;
                await t.db.update('db2/tbl_chat', chat).id(chat.id).promise();
            }

            var message = {};
            message.id = msg.id;
            message.chatid = chat.id;
            message.type = msg.type;


            if (typeof msg.content == 'string') {
                message.content = msg.content;
            } else {
                message.content = msg.content.url;
                message.caption = msg.content.body;
                message.data = JSON.stringify(msg.content);
            }
            message.value = msg.content;
            message.isviewonce = msg.isviewonce;
            message.dtcreated = NOW;
            message.custom = msg.custom;
            message.kind = 'received';
            message.isgroup = msg.isgroup;
            message.isread = false;

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

    async ask(number, chatid, content, type, isgroup, istag, user, group, msg) {
        var t = this;
        
        console.log('ASKING...');
        const obj = {
            id: msg.msgid,
            content: content,
            number: number,
            chatid: chatid,
            type: type,
            isgroup: isgroup,
            istag: istag,
            from: user,
            group: group,
            isviewonce: false
        };
        if (t.origin == 'zapwize') {
            t.ws_send(obj);

        }
        console.log(obj);
        this.saveToDatabase(obj);
        t.emit('ask', obj);
    }

    ensureConnection() {
        if (!this.socket || this.socket.state !== 'open') {
            throw new Error('WhatsApp is not connected');
        }
    }

    formatJid(chatid) {
        return chatid.includes('@') ? chatid : (chatid.isPhone?.() ? `${chatid}@s.whatsapp.net` : `${chatid}@g.us`);
    }

    async sendMessage(data) {
        this.ensureConnection();
        const jid = this.formatJid(data.chatid);
        const options = data.quoted ? { quoted: data.quoted } : {};

        const content = { text: data.content };
        if (data.mentions) content.mentions = data.mentions;

        try {
            const result = await this.socket.sendMessage(jid, content, options);
            this.logger.debug({ jid, type: 'text' }, 'Text message sent');
            return result;
        } catch (err) {
            this.logger.error({ err, jid }, 'Failed to send text message');
            throw err;
        }
    }

    async sendMedia(data) {
        this.ensureConnection();
        const jid = this.formatJid(data.chatid);

        let buffer, filename, mimetype = 'application/octet-stream';

        if (data.type === 'url') {
            const fs = F.Fs;
            data.ext = U.getExtension(data.url);
            filename = `file_${Date.now()}.${data.ext}`;
            mimetype = U.getContentType(filename);

            await new Promise((resolve, reject) => {
                DOWNLOAD(data.url, PATH.temp(filename), err => {
                    if (err) return reject(err);
                    buffer = fs.readFileSync(PATH.temp(filename));
                    fs.unlinkSync(PATH.temp(filename));
                    resolve();
                });
            });
        } else if (data.type === 'base64') {
            buffer = Buffer.from(data.content.replace(/^data:.*?base64,/, ''), 'base64');
        } else {
            throw new Error('Unsupported media input type. Use "url" or "base64".');
        }

        const mediaContent = {
            caption: data.caption || '',
            mimetype: mimetype,
        };

        switch (data.mediaCategory) {
            case 'image':
                mediaContent.image = buffer;
                break;
            case 'video':
                mediaContent.video = buffer;
                mediaContent.gifPlayback = !!data.gif;
                mediaContent.ptv = !!data.ptv;
                break;
            case 'audio':
                mediaContent.audio = buffer;
                break;
            default:
                mediaContent.document = buffer;
                mediaContent.fileName = filename;
                break;
        }

        if (data.viewOnce) mediaContent.viewOnce = true;

        try {
            const result = await this.socket.sendMessage(jid, mediaContent);
            this.logger.debug({ jid, type: data.mediaCategory || 'document' }, 'Media sent');
            return result;
        } catch (err) {
            this.logger.error({ err, jid }, 'Failed to send media');
            throw err;
        }
    }

    async sendLocation(data) {
        this.ensureConnection();
        const jid = this.formatJid(data.chatid);
        const location = {
            location: {
                degreesLatitude: data.lat,
                degreesLongitude: data.lng,
            },
        };
        return this.socket.sendMessage(jid, location);
    }

    async sendContact(data) {
        this.ensureConnection();
        const jid = this.formatJid(data.chatid);

        const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${data.name}\nORG:${data.org || ''};\nTEL;type=CELL;type=VOICE;waid=${data.phone}:${data.phone}\nEND:VCARD`;

        const contactMsg = {
            contacts: {
                displayName: data.name,
                contacts: [{ vcard }],
            },
        };

        return this.socket.sendMessage(jid, contactMsg);
    }

    async sendReaction(data) {
        this.ensureConnection();
        return this.socket.sendMessage(data.chatid, {
            react: {
                text: data.reaction || '',
                key: data.key,
            },
        });
    }

    async sendPoll(data) {
        this.ensureConnection();
        const jid = this.formatJid(data.chatid);
        const poll = {
            poll: {
                name: data.name,
                values: data.options,
                selectableCount: data.selectableCount || 1,
                toAnnouncementGroup: data.toAnnouncementGroup || false
            },
        };
        return this.socket.sendMessage(jid, poll);
    }

    async forwardMessage(data) {
        this.ensureConnection();
        const jid = this.formatJid(data.chatid);
        return this.socket.sendMessage(jid, { forward: data.message });
    }

    async pinMessage(data) {
        this.ensureConnection();
        return this.socket.sendMessage(data.chatid, {
            pin: {
                type: data.unpin ? 0 : 1,
                time: data.duration || 86400,
                key: data.key,
            },
        });
    }

    async dispatch(msg) {
        switch (msg.type) {
            case 'text':
                return await this.sendMessage(msg);
            case 'file':
                return await this.sendMedia(msg);
            case 'location':
                return await this.sendLocation(msg);
            case 'contact':
                return await this.sendContact(msg);
            case 'reaction':
                return await this.sendReaction(msg);
            case 'poll':
                return await this.sendPoll(msg);
            case 'forward':
                return await this.forwardMessage(msg);
            case 'pin':
                return await this.pinMessage(msg);
            default:
                throw new Error(`Unsupported message type: ${msg.type}`);
        }
    }
    async onwhatsapp(data) {
        if (!data.chatid.includes('@')) {
            data.chatid = data.chatid.isPhone?.() ? data.chatid + '@s.whatsapp.net' : data.chatid + '@g.us';
        }

        // use onWhatsapp
        let result = await this.socket.onWhatsApp(data.chatid);

        return result;

    }




    async message(msg, ctrl) {
        var t = this;
        var output = { reqid: msg.reqid || UID(), state: t.state, success: true };
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
            case 'onwhatsapp':
                if (t.state == 'open')
                    output.content = await t.onwhatsapp(msg);
                else
                    output.success = false;
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

        if (!ctrl)
            return output;

        ctrl && !ctrl.ws && ctrl.json(output);
        ctrl && ctrl.ws && ctrl.client.send(output);
    }

    save_file(data, callback) {

        if (data.ext == 'jpeg' || data.ext == 'jpe')
            data.ext = 'jpg';


        var obj = {};
        obj.name = GUID(35) + data.ext;
        obj.file = data.content;
        var fs = FILESTORAGE(data.number);

        var id = data.custom.dp;
        fs.save(id || UID(), obj.name, obj.file.base64ToBuffer(), function (err, meta) {
            meta.url = '/download/' + data.number + '_{0}.{1}'.format(meta.id.sign(CONF.salt), meta.ext);
            callback && callback(meta);
        }, data.custom, data.custom.type == 'status' ? '1 day' : CONF.ttl);
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

        console.log('Instance: [' + F.id + '] ' + t.phone + ' - ' + t.state);
        t.refresh_days();
        t.refresh_limits();
    }

    async init() {
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
                    getMessage: this.store.getMessage.bind(this.store),
                    // Remove problematic options that cause issues
                    // generateHighQualityLinkPreview: false,
                    syncFullHistory: true,
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
                try {
                    this.currentPairingCode = await this.requestPairingCode();
                } catch (error) {
                    this.logger.error({ error }, 'Failed to request pairing code');
                }
            } else if (qr && !this.usePairingCode) {
                this.qrcode = qr;
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

        return await this.requestPairingCode();
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
        const operationId = this.generateOperationId();
        const startTime = Date.now();
        
        try {
            // Validate input with extreme prejudice
            if (!this.validateMessageUpdate(messageUpdate)) {
                this.logger.warn(`[${operationId}] Invalid message update rejected`);
                return { success: false, reason: 'invalid_input' };
            }

            // Circuit breaker pattern
            if (this.isSystemOverloaded()) {
                this.logger.error(`[${operationId}] System overloaded - emergency brake activated`);
                await this.emergencyThrottle();
            }

            // Process each message with military precision
            const results = await this.processMessagesWithFailover(messageUpdate.messages, operationId);
            
            // Ensure queue processing is active
            await this.ensureQueueProcessing(operationId);
            
            const duration = Date.now() - startTime;
            this.logger.info(`[${operationId}] Messages handled successfully in ${duration}ms`);
            
            return { success: true, processed: results.processed, failed: results.failed };
            
        } catch (error) {
            return await this.handleCriticalFailure(error, operationId, 'handleMessages');
        }
    }

    async processMessagesWithFailover(messages, operationId) {
        const results = { processed: 0, failed: 0 };
        
        for (const message of messages) {
            try {
                // Deduplication check
                const messageHash = this.generateMessageHash(message);
                if (this.processedMessages.has(messageHash)) {
                    this.logger.debug(`[${operationId}] Duplicate message skipped: ${messageHash}`);
                    continue;
                }

                // Queue size protection
                if (this.messageQueue.length >= this.maxQueueSize) {
                    await this.handleQueueOverflow(operationId);
                    if (this.messageQueue.length >= this.maxQueueSize) {
                        this.logger.error(`[${operationId}] Queue still full after overflow handling`);
                        results.failed++;
                        continue;
                    }
                }

                // Add to queue with metadata
                const queueItem = {
                    message,
                    timestamp: Date.now(),
                    operationId,
                    retryCount: 0,
                    messageHash
                };

                this.messageQueue.push(queueItem);
                this.processedMessages.add(messageHash);
                results.processed++;

            } catch (error) {
                this.logger.error(`[${operationId}] Failed to queue message:`, error);
                results.failed++;
            }
        }

        return results;
    }

    /**
     * MILITARY GRADE: Queue processing with guaranteed execution
     */
    async processMessageQueue() {
        const operationId = this.generateOperationId();
        
        if (this.processingQueue) {
            this.logger.debug(`[${operationId}] Queue processing already active`);
            return;
        }

        this.processingQueue = true;
        this.logger.info(`[${operationId}] Queue processing started`);

        try {
            while (this.messageQueue.length > 0 && !this.isShuttingDown) {
                const queueItem = this.messageQueue.shift();
                
                if (!queueItem) continue;

                // Check message age (prevent processing stale messages)
                if (this.isMessageStale(queueItem)) {
                    this.logger.warn(`[${operationId}] Stale message discarded: ${queueItem.messageHash}`);
                    continue;
                }

                await this.processMessageWithRetry(queueItem, operationId);
            }
        } catch (criticalError) {
            await this.handleCriticalFailure(criticalError, operationId, 'processMessageQueue');
        } finally {
            this.processingQueue = false;
            this.logger.info(`[${operationId}] Queue processing completed`);
        }
    }

    async processMessageWithRetry(queueItem, operationId) {
        const maxRetries = this.MAX_RETRIES;
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await this.processMessageSafely(queueItem.message, operationId, attempt);
                
                // Success - remove from failed tracking
                this.failedMessages.delete(queueItem.messageHash);
                return;

            } catch (error) {
                lastError = error;
                queueItem.retryCount = attempt;
                
                this.logger.warn(`[${operationId}] Message processing attempt ${attempt}/${maxRetries} failed:`, {
                    messageId: queueItem.message.key?.id,
                    error: error.message
                });

                if (attempt < maxRetries) {
                    await this.sleep(this.RETRY_DELAY * attempt); // Exponential backoff
                }
            }
        }

        // All retries exhausted - handle failure
        await this.handleMessageFailure(queueItem, lastError, operationId);
    }

    /**
     * MILITARY GRADE: Message processing with comprehensive error handling
     */
    async processMessageSafely(message, operationId, attempt = 1) {
        const messageId = message.key?.id || 'unknown';
        const startTime = Date.now();
        
        try {
            // Timeout protection
            const processingPromise = this.processMessage(message);
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Processing timeout')), this.CRITICAL_TIMEOUT)
            );
            
            await Promise.race([processingPromise, timeoutPromise]);
            
            const duration = Date.now() - startTime;
            this.logger.debug(`[${operationId}] Message ${messageId} processed in ${duration}ms (attempt ${attempt})`);
            
        } catch (error) {
            const duration = Date.now() - startTime;
            this.logger.error(`[${operationId}] Message ${messageId} failed after ${duration}ms (attempt ${attempt}):`, error);
            throw error;
        }
    }

    /**
     * MILITARY GRADE: Core message processing with bulletproof handlers
     */
    async processMessage(message) {
        if (!message || !message.message) {
            throw new Error('Invalid message structure');
        }

        const msg = message.message;

        // Handle protocol messages (revoke, etc.)
        if (msg.protocolMessage) {
            return await this.handleProtocolMessageSafely(msg.protocolMessage, message);
        }

        // Auto-read with error isolation
        await this.handleAutoReadSafely(message);

        // Get message type with fallback
        const mtype = await this.getMessageTypeSafely(message);
        if (!mtype) {
            throw new Error('Unable to determine message type');
        }

        // Route to appropriate handler with isolation
        await this.routeMessageSafely(message, mtype);

        // Emit event with error isolation
        await this.emitMessageEventSafely(message);
    }

    async handleProtocolMessageSafely(protocolMessage, message) {
        try {
            if (protocolMessage.type === 0) { // Revoke message
                const revoked = protocolMessage.key;
                
                if (!revoked?.id) {
                    throw new Error('Invalid revoke key');
                }

                console.log('[REVOKED] ID:', revoked.id);

                // Database operation with retry
                const restoredMessage = await this.executeWithRetry(async () => {
                    return await this.db.read('db2/tbl_message')
                        .where('id', revoked.id)
                        .fields('id,content,kind')
                        .promise();
                });

                if (!restoredMessage) {
                    console.warn('[NOT FOUND IN DB]');
                    return;
                }

                console.log('[RESTORED]', restoredMessage);

                // Update with retry
                await this.executeWithRetry(async () => {
                    return await this.db.update('db2/tbl_message', {
                        kind: 'revoked',
                        dtdeleted: 'NOW()',
                        isDeleted: true
                    }).id(restoredMessage.id).promise();
                });

                // Safe emit
                this.safeEmit('message-revoked', { revoked, restoredMessage });
            }
        } catch (error) {
            console.error('[REVOKE HANDLER ERROR]', error);
            // Don't throw - protocol message errors shouldn't kill the process
        }
    }

    async handleAutoReadSafely(message) {
        if (!this.config?.autoRead || !message.key || message.key.fromMe) {
            return;
        }

        try {
            // Commented out as in original, but with proper error handling
            // await this.socket.readMessages([message.key]);
        } catch (error) {
            this.logger.warn('[WARN] Failed to mark message as read:', error.message);
            // Continue processing - read receipt failure is not critical
        }
    }

    async getMessageTypeSafely(message) {
        try {
            const mtype = getContentType(message.message);
            console.log('📩 Received message:', mtype);
            return mtype;
        } catch (error) {
            console.error('[ERROR] Failed to get message type:', error);
            // Try fallback detection
            return this.fallbackMessageTypeDetection(message.message);
        }
    }

    async routeMessageSafely(message, mtype) {
        const handlers = {
            'audioMessage': () => this.safeHandlerWrapper(FUNC.handle_voice, message, this, this.socket),
            'imageMessage': () => this.safeHandlerWrapper(FUNC.handle_image, message, this, this.socket),
            'documentMessage': () => this.handleDocumentSafely(message),
            'documentWithCaptionMessage': () => this.handleDocumentSafely(message),
            'videoMessage': () => this.handleDocumentSafely(message),
            'conversation': () => this.safeHandlerWrapper(FUNC.handle_textonly, message, this, this.socket),
            'locationMessage': () => this.safeHandlerWrapper(FUNC.handle_location, message, this, this.socket),
            'liveLcationMessage': () => this.safeHandlerWrapper(FUNC.handle_livelocation, message, this, this.socket),
            'contactMessage': () => this.safeHandlerWrapper(FUNC.handle_contact, message, this, this.socket),
            'stickerMessage': () => this.safeHandlerWrapper(FUNC.handle_sticker, message, this, this.socket),
            'lottieStickerMessage': () => this.safeHandlerWrapper(FUNC.handle_lottie, message, this, this.socket),
            'reactionMessage': () => this.safeHandlerWrapper(FUNC.handle_reaction, message, this, this.socket),
            'eventMessage': () => this.safeHandlerWrapper(FUNC.handle_event, message, this, this.socket),
            'pollCreationMessageV3': () => this.safeHandlerWrapper(FUNC.handle_poll, message, this, this.socket),
            'extendedTextMessage': () => this.safeHandlerWrapper(FUNC.handle_textonly, message, this, this.socket)
        };

        let status = () => this.safeHandlerWrapper(FUNC.handle_status, message, this, this.socket);

        let chatid = message.key.remoteJid;
        if (chatid.includes('@newsletter'))
            return;

        const handler = chatid.includes('status@broadcast') ? status : handlers[mtype];
        if (handler) {
            await handler();
        } else {
            console.warn('[WARN] Unknown message type:', mtype);
        }
    }

    async handleDocumentSafely(message) {
        try {
            if (message.key?.remoteJid?.includes("status@broadcast")) {
                await this.safeHandlerWrapper(FUNC.handle_status, message, this, this.socket);
            } else {
                await this.safeHandlerWrapper(FUNC.handle_media, message, this, this.socket);
            }
        } catch (error) {
            console.error('[ERROR] Document handling failed:', error);
            throw error;
        }
    }

    /**
     * MILITARY GRADE: Message deletion handler with guaranteed execution
     */
    async handleMessageDelete(deleteUpdate) {
        const operationId = this.generateOperationId();
        
        try {
            console.log(`[${operationId}] Handling deleted messages`, deleteUpdate);
            
            if (!deleteUpdate) {
                throw new Error('Invalid delete update');
            }

            // Validate delete update structure
            this.validateDeleteUpdate(deleteUpdate);

            // Safe emit with retry
            await this.safeEmitWithRetry('message-delete', deleteUpdate, operationId);
            
            this.logger.info(`[${operationId}] Message delete handled successfully`);
            
        } catch (error) {
            await this.handleCriticalFailure(error, operationId, 'handleMessageDelete');
        }
    }

    // === UTILITY METHODS ===

    async safeHandlerWrapper(handler, ...args) {
        try {
            await handler(...args);
        } catch (error) {
            console.error(`[ERROR] Handler ${handler.name} failed:`, error);
            throw error;
        }
    }

    async executeWithRetry(operation, maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                if (attempt === maxRetries) throw error;
                await this.sleep(this.RETRY_DELAY * attempt);
            }
        }
    }

    async safeEmitWithRetry(event, data, operationId, maxRetries = 3) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                this.emit(event, data);
                return;
            } catch (error) {
                this.logger.warn(`[${operationId}] Emit attempt ${attempt} failed:`, error.message);
                if (attempt === maxRetries) {
                    throw new Error(`Failed to emit ${event} after ${maxRetries} attempts`);
                }
                await this.sleep(100 * attempt);
            }
        }
    }

    safeEmit(event, data) {
        try {
            this.emit(event, data);
        } catch (error) {
            console.error(`[ERROR] Failed to emit ${event}:`, error);
        }
    }

    async emitMessageEventSafely(message) {
        try {
            this.emit('message', message);
        } catch (error) {
            console.error('[ERROR] Failed to emit message event:', error);
            // Don't throw - event emission failure shouldn't kill processing
        }
    }

    validateMessageUpdate(messageUpdate) {
        return messageUpdate && 
               messageUpdate.type === 'notify' && 
               Array.isArray(messageUpdate.messages);
    }

    validateDeleteUpdate(deleteUpdate) {
        if (!deleteUpdate || typeof deleteUpdate !== 'object') {
            throw new Error('Invalid delete update structure');
        }
    }

    generateMessageHash(message) {
        const key = message.key || {};
        return `${key.id || 'unknown'}_${key.remoteJid || 'unknown'}_${Date.now()}`;
    }

    generateOperationId() {
        return `op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    isSystemOverloaded() {
        return this.messageQueue.length > (this.maxQueueSize * 0.9);
    }

    isMessageStale(queueItem, maxAge = 300000) { // 5 minutes
        return (Date.now() - queueItem.timestamp) > maxAge;
    }

    async ensureQueueProcessing(operationId) {
        if (!this.processingQueue && this.messageQueue.length > 0) {
            this.logger.info(`[${operationId}] Starting queue processing`);
            setImmediate(() => this.processMessageQueue());
        }
    }

    async handleQueueOverflow(operationId) {
        this.logger.warn(`[${operationId}] Queue overflow detected - implementing emergency measures`);
        
        // Remove oldest messages
        const removeCount = Math.floor(this.maxQueueSize * 0.1);
        const removed = this.messageQueue.splice(0, removeCount);
        
        this.logger.warn(`[${operationId}] Removed ${removed.length} oldest messages from queue`);
    }

    async handleMessageFailure(queueItem, error, operationId) {
        const messageHash = queueItem.messageHash;
        
        this.failedMessages.set(messageHash, {
            queueItem,
            error: error.message,
            timestamp: Date.now(),
            operationId
        });

        this.logger.error(`[${operationId}] Message permanently failed: ${messageHash}`, {
            error: error.message,
            retryCount: queueItem.retryCount
        });

        // Could implement dead letter queue here
        this.safeEmit('message-failed', { queueItem, error });
    }

    async handleCriticalFailure(error, operationId, method) {
        this.logger.error(`[${operationId}] CRITICAL FAILURE in ${method}:`, error);
        
        // Could implement circuit breaker, alerting, etc.
        this.safeEmit('critical-error', { error, operationId, method });
        
        return { success: false, error: error.message, operationId };
    }

    async emergencyThrottle() {
        this.logger.warn('Emergency throttle activated');
        await this.sleep(5000); // 5 second pause
    }

    fallbackMessageTypeDetection(message) {
        if (message.conversation) return 'conversation';
        if (message.extendedTextMessage) return 'extendedTextMessage';
        if (message.imageMessage) return 'imageMessage';
        if (message.audioMessage) return 'audioMessage';
        if (message.videoMessage) return 'videoMessage';
        if (message.documentMessage) return 'documentMessage';
        return null;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }


    async handlePresenceUpdate(presenceUpdate) {
        console.log("[LOUIS BERTSON]", "handling presence updates", presenceUpdate);

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

class ClusterWhatsAppSessionManager extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = config;
        this.instances = MAIN.instances;
        this.index = config.index || 0;
        this.logger = createLogger('session-manager-' + F.id + '-' + this.index);
        this.maxInstances = config.maxInstances || 1000;
        this.instancesPerWorker = config.instancesPerWorker || 100;
        this.clusterId = F.id;

        // Cluster-specific configurations
        this.maxInstancesPerCluster = Math.floor(this.maxInstances / (config.expectedClusters || 4));
        this.clusterInstanceMap = MAIN.clusters; // Track which cluster has which instances

        // Health monitoring
        this.healthCheckInterval = config.healthCheckInterval || 30000;
        this.startHealthMonitoring();

        // Setup cluster event handlers
        this.setupClusterHandlers();


    }

    setupClusterHandlers() {
        // Listen for cluster-wide events
        ON('cluster-instance-created', (data) => {
            console.log('Cluster scope saved: overriding?', data.clusterId == F.id);
            this.clusterInstanceMap.set(data.phone, data.clusterId);
            this.logger.info({ phone: data.phone, clusterId: data.clusterId }, 'Remote instance created');
        });

        ON('cluster-instance-removed', (data) => {
            this.clusterInstanceMap.delete(data.phone);
            this.logger.info({ phone: data.phone, clusterId: data.clusterId }, 'Remote instance removed');
        });

        ON('cluster-health-check', (data) => {
            // Respond with local health status
            EMIT2('cluster-health-response', {
                clusterId: this.clusterId,
                health: this.getLocalHealthStatus(),
                requestId: data.requestId
            });
        });


        
    }

    async createInstance(phone, data) {
        const redisKey = `lock:instance:${phone}`;
        const lockTTL = 4000; // 4 seconds max hold
        const lockToken = UID();

        const acquired = await MAIN.redis.set(redisKey, lockToken, 'NX', 'PX', lockTTL);
        if (!acquired) {
            console.warn(`[LOCK] Redis denied instance creation for ${phone}`);
            return false;
        }

        try {
            const exists = await this.checkInstanceExistsGlobally(phone);
            if (exists) {
                console.warn(`[DUPLICATE] Instance already exists on ${exists} for ${phone}`);
                return false;
            }

            const instance = new WhatsAppInstance(phone, data);

            instance.initialize();

            // set handlers
            this.setupInstanceHandlers(instance);

            MAIN.instances.set(phone, instance);
            EMIT2('cluster-instance-created', { phone, clusterId: F.id });
            console.log(`[CREATE] Instance ${phone} bootstrapped on ${F.id}`);
            return true;
        } catch (err) {
            console.error(`[FAILURE] Error creating instance for ${phone}:`, err);
            return false;
        } finally {
            const value = await MAIN.redis.get(redisKey);
            if (value === lockToken) {
                await MAIN.redis.del(redisKey);
                console.log(`[UNLOCK] Redis lock released for ${phone}`);
            }
        }
    };


    async createInstanceWithPairingCode(phone, config = {}) {
        const pairingConfig = {
            ...config,
            usePairingCode: true,
            printQRInTerminal: false
        };

        return this.createInstance(phone, pairingConfig);
    }

    async createInstanceWithQRCode(phone, config = {}) {
        const pairingConfig = {
            ...config,
            usePairingCode: false,
            printQRInTerminal: false
        };

        return this.createInstance(phone, pairingConfig);
    }

    async checkInstanceExistsGlobally(phone) {
        try {
            const response = await MAIN.clusterproxy.sendWithAck('cluster-find-instance', { phone, clusterId: F.id }, { retries: 2, timeout: 30000 });
            const data = await MAIN.clusterproxy.unwrap(response);
            return data?.found ? data.clusterId : false;
        } catch (err) {
            console.warn(`[ClusterProxy] Fallback triggered: ${err.message}`);
            return false; // Fallback to local state if no ACK
        }
    }

    restore_session(data) {
        if (data.managerid == this.index && data.clusterid == this.clusterId) {
            console.log(`[${F.id}] restoring ${data.phone}`);
            this.createInstance(data.phone);
        }
    }

    setupInstanceHandlers(instance) {

        instance.on('error', (error) => {
            this.logger.error({
                instanceId: instance.id,
                phone: instance.phone,
                error,
                clusterId: this.clusterId
            }, 'Instance error');
            this.emit('instance-error', { instance, error });
        });


        instance.on('pairing-code', (data) => {
            this.logger.info({
                instanceId: instance.id,
                phone: data.phone,
                code: data.code,
                clusterId: this.clusterId
            }, 'Pairing code generated');
            this.emit('pairing-code', data);
        });

        instance.on('pairing-code-expired', (data) => {
            this.logger.warn({
                instanceId: instance.id,
                phone: data.phone,
                clusterId: this.clusterId
            }, 'Pairing code expired');
            this.emit('pairing-code-expired', data);
        });

        instance.on('pairing-code-error', (data) => {
            this.logger.error({
                instanceId: instance.id,
                phone: data.phone,
                error: data.error,
                clusterId: this.clusterId
            }, 'Pairing code error');
            this.emit('pairing-code-error', data);
        });

        instance.on('resource-critical', async (data) => {
            this.logger.warn({
                instanceId: instance.id,
                phone: instance.phone,
                data,
                clusterId: this.clusterId
            }, 'Instance resource critical');
            await this.removeInstance(instance.phone, 'resource-critical');
        });

        instance.on('max-reconnect-attempts', async () => {
            this.logger.warn({
                instanceId: instance.id,
                phone: instance.phone,
                clusterId: this.clusterId
            }, 'Instance max reconnect attempts reached');
            await this.removeInstance(instance.phone, 'max-reconnect-attempts');
        });

        instance.on('shutdown', () => {
            this.logger.info({
                instanceId: instance.id,
                phone: instance.phone,
                clusterId: this.clusterId
            }, 'Instance shutdown');
            this.instances.delete(instance.phone);
        });

        // Cluster-specific handlers
        instance.on('cluster-message', (data) => {
            // Broadcast message to other clusters if needed
            if (data.broadcast) {
                EMIT2('cluster-broadcast-message', {
                    phone: instance.phone,
                    message: data.message,
                    targetCluster: data.targetCluster || 'all',
                    sourceCluster: this.clusterId
                });
            }
        });
        instance.on('ask', (data) => {
            EMIT2('cluster-broadcast-message', {
                event: 'ask',
                phone: instance.phone,
                message: data,
                targetCluster: data.targetCluster || 'all',
                sourceCluster: F.id
            });
        });
    }

    async removeInstance(phone, reason = 'manual') {
        const instance = this.instances.get(phone);
        if (!instance) {
            throw new Error(`Instance for ${phone} not found on cluster ${this.clusterId}`);
        }

        try {
            await instance.gracefulShutdown(reason);
            this.instances.delete(phone);

            // Notify other clusters
            EMIT2('cluster-instance-removed', {
                phone: phone,
                clusterId: this.clusterId,
                reason: reason,
                timestamp: Date.now()
            });

            this.logger.info({
                phone,
                reason,
                clusterId: this.clusterId
            }, 'Instance removed successfully');

            this.emit('instance-removed', { phone, reason });

        } catch (error) {
            this.logger.error({
                phone,
                error,
                clusterId: this.clusterId
            }, 'Error removing instance');
            throw error;
        }
    }

    getInstance(phone) {
        return this.instances.get(phone);
    }
    async getInstanceGlobally(phone) {
        // Check cluster map

        const clusterId = this.clusterInstanceMap.get(phone);
        if (clusterId) {
            return { instance: null, clusterId: clusterId };
        }

        // Query all clusters
        const clusterLocation = await this.checkInstanceExistsGlobally(phone);
        if (clusterLocation) {
            return { instance: null, clusterId: clusterLocation };
        }

        return null;
    }

    getAllInstances() {
        return Array.from(this.instances.values());
    }

    async refreshPairingCode(phone) {
        const instance = this.getInstance(phone);
        if (!instance) {
            throw new Error(`Instance for ${phone} not found on cluster ${this.clusterId}`);
        }

        return instance.refreshPairingCode();
    }

    getPairingCode(phone) {
        const instance = this.getInstance(phone);
        if (!instance) {
            throw new Error(`Instance for ${phone} not found on cluster ${this.clusterId}`);
        }

        return instance.getCurrentPairingCode();
    }

    getLocalHealthStatus() {
        const instances = this.getAllInstances();
        const health = instances.map(instance => instance.getHealth());

        return {
            clusterId: this.clusterId,
            totalInstances: instances.length,
            maxInstancesPerCluster: this.maxInstancesPerCluster,
            healthyInstances: health.filter(h => h.state === 'open').length,
            pairingCodeInstances: health.filter(h => h.usePairingCode).length,
            activePairingCodes: health.filter(h => h.isPairingCodeActive).length,
            instances: health,
            systemMemory: process.memoryUsage(),
            uptime: process.uptime(),
        };
    }

    async getGlobalHealthStatus() {
        return new Promise((resolve) => {
            const requestId = Date.now() + Math.random();
            const responses = [];
            const timeout = setTimeout(() => {
                resolve({
                    localHealth: this.getLocalHealthStatus(),
                    clusterHealth: responses,
                    totalManagers: responses.length,
                    totalClusters: MAIN.clusters.size
                });
            }, 2000);

            const responseHandler = (data) => {
                if (data.requestId === requestId) {
                    responses.push(data.health);
                }
            };

            ON('cluster-health-response', responseHandler);

            EMIT2('cluster-health-check', {
                requestId: requestId
            });
        });
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
            this.logger.warn({
                instanceId: instance.id,
                phone: instance.phone,
                clusterId: this.clusterId
            }, 'Removing unhealthy instance');
            await this.removeInstance(instance.phone, 'health-check-failed');
        }

        this.emit('health-check-completed', {
            clusterId: this.clusterId,
            total: instances.length,
            unhealthy: unhealthyInstances.length,
        });
    }

    async gracefulShutdown() {
        this.logger.info({ clusterId: this.clusterId }, 'Starting graceful shutdown of all instances');

        if (this.healthTimer) {
            clearInterval(this.healthTimer);
        }

        const instances = this.getAllInstances();
        const shutdownPromises = instances.map(instance =>
            instance.gracefulShutdown('manager-shutdown').catch(error =>
                this.logger.error({
                    error,
                    instanceId: instance.id,
                    clusterId: this.clusterId
                }, 'Error during instance shutdown')
            )
        );

        await Promise.allSettled(shutdownPromises);
        this.instances.clear();

        this.logger.info({ clusterId: this.clusterId }, 'All instances shutdown completed');
    }

}

// Extended WhatsApp Instance with cluster awareness
class ClusterAwareWhatsAppInstance extends WhatsAppInstance {
    constructor(phone, config) {
        super(phone, config);
        this.clusterId = config.clusterId;
        this.clusterAware = config.clusterAware || false;
    }

    handleClusterMessage(message) {
        // Handle messages from other clusters
        if (this.ws_clients) {
            Object.values(this.ws_clients).forEach(client => {
                client.send({
                    type: 'cluster-message',
                    clusterId: message.sourceCluster,
                    data: message.data
                });
            });
        }
    }

    getHealth() {
        const health = super.getHealth();
        return {
            ...health,
            clusterId: this.clusterId,
            clusterAware: this.clusterAware
        };
    }
}

// Export classes for main usage

MAIN.WhatsAppInstance = WhatsAppInstance;
MAIN.ResourceMonitor = ResourceMonitor;
MAIN.CircuitBreaker = CircuitBreaker;
MAIN.RedisManager = RedisManager;
MAIN.ClusterAwareWhatsAppInstance = ClusterAwareWhatsAppInstance;
MAIN.ClusterWhatsAppSessionManager = ClusterWhatsAppSessionManager;


class BootLoader extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = config;
        this.clusters = new Map();
        this.roundRobinIndex = 0;
        this.healthCheckInterval = config.healthCheckInterval || 10000;
        this.maxInstancesPerCluster = config.maxInstancesPerCluster || 250;
        this.instanceDistribution = new Map(); // phone -> clusterId mapping

        // Strategy for load balancing
        this.balancingStrategy = config.balancingStrategy || 'round-robin'; // round-robin, least-loaded, resource-aware

        this.setupClusterMonitoring();
        this.startHealthMonitoring();
    }

    setupClusterMonitoring() {
        // Listen for cluster health updates
        ON('cluster-health-response', (data) => {
            this.updateClusterHealth(data.clusterId, data.health);
        });

        // Listen for instance creation/removal across clusters
        ON('cluster-instance-created', (data) => {
            console.log('Cluster scop override', data.clusterId != F.id);
            this.instanceDistribution.set(data.phone, data.clusterId);
            this.updateClusterInstanceCount(data.clusterId, 1);
        });


        ON('cluster-instance-removed', (data) => {
            this.instanceDistribution.delete(data.phone);
            this.updateClusterInstanceCount(data.clusterId, -1);
        });
    }

    updateClusterHealth(clusterId, health) {
        const existing = this.clusters.get(clusterId) || {};
        this.clusters.set(clusterId, {
            ...existing,
            health: health,
            lastHealthUpdate: Date.now(),
            isHealthy: this.isClusterHealthy(health)
        });
    }

    updateClusterInstanceCount(clusterId, delta) {
        const existing = this.clusters.get(clusterId) || { instanceCount: 0 };
        existing.instanceCount = Math.max(0, existing.instanceCount + delta);
        this.clusters.set(clusterId, existing);
    }

    isClusterHealthy(health) {
        if (!health) return false;

        const memoryUsage = health.systemMemory;
        const memoryThreshold = this.config.memoryThreshold || 0.8;
        const memoryUsagePercent = memoryUsage.heapUsed / memoryUsage.heapTotal;

        return memoryUsagePercent < memoryThreshold &&
            health.healthyInstances > 0 &&
            health.totalInstances < this.maxInstancesPerCluster;
    }

    getOptimalClusterForNewInstance(phone) {
        // Check if instance already exists
        const existingCluster = this.instanceDistribution.get(phone);
        if (existingCluster) {
            return { clusterId: existingCluster, reason: 'existing' };
        }

        const healthyClusters = Array.from(this.clusters.entries())
            .filter(([_, cluster]) => cluster.isHealthy)
            .map(([clusterId, cluster]) => ({ clusterId, ...cluster }));

        if (healthyClusters.length === 0) {
            throw new Error('No healthy clusters available');
        }

        let selectedCluster;

        switch (this.balancingStrategy) {
            case 'least-loaded':
                selectedCluster = healthyClusters.reduce((min, cluster) =>
                    cluster.instanceCount < min.instanceCount ? cluster : min
                );
                break;

            case 'resource-aware':
                selectedCluster = healthyClusters.reduce((best, cluster) => {
                    const currentScore = this.calculateClusterScore(cluster);
                    const bestScore = this.calculateClusterScore(best);
                    return currentScore > bestScore ? cluster : best;
                });
                break;

            case 'round-robin':
            default:
                this.roundRobinIndex = (this.roundRobinIndex + 1) % healthyClusters.length;
                selectedCluster = healthyClusters[this.roundRobinIndex];
                break;
        }

        return {
            clusterId: selectedCluster.clusterId,
            reason: this.balancingStrategy,
            clusterLoad: selectedCluster.instanceCount
        };
    }

    calculateClusterScore(cluster) {
        if (!cluster.health) return 0;

        const memoryScore = 1 - (cluster.health.systemMemory.heapUsed / cluster.health.systemMemory.heapTotal);
        const loadScore = 1 - (cluster.instanceCount / this.maxInstancesPerCluster);
        const healthScore = cluster.health.healthyInstances / Math.max(1, cluster.health.totalInstances);

        return (memoryScore * 0.4) + (loadScore * 0.4) + (healthScore * 0.2);
    }

    getClusterForInstance(phone) {
        return this.instanceDistribution.get(phone);
    }

    getClusterStats() {
        const stats = {
            totalClusters: this.clusters.size,
            healthyClusters: 0,
            totalInstances: 0,
            clusterDetails: []
        };

        for (const [clusterId, cluster] of this.clusters) {
            if (cluster.isHealthy) stats.healthyClusters++;
            stats.totalInstances += cluster.instanceCount || 0;

            stats.clusterDetails.push({
                clusterId,
                isHealthy: cluster.isHealthy,
                instanceCount: cluster.instanceCount || 0,
                memoryUsage: cluster.health?.systemMemory,
                lastHealthUpdate: cluster.lastHealthUpdate,
                score: this.calculateClusterScore(cluster)
            });
        }

        return stats;
    }

    startHealthMonitoring() {
        this.healthTimer = setInterval(() => {
            this.performClusterHealthCheck();
        }, this.healthCheckInterval);
    }

    performClusterHealthCheck() {
        // Request health from all clusters
        const requestId = Date.now() + Math.random();
        EMIT2('cluster-health-check', { requestId });

        // Clean up stale cluster data
        const staleThreshold = Date.now() - (this.healthCheckInterval * 3);
        for (const [clusterId, cluster] of this.clusters) {
            if (cluster.lastHealthUpdate < staleThreshold) {
                this.clusters.delete(clusterId);
                console.warn(`Removed stale cluster: ${clusterId}`);
            }
        }
    }

    async redistributeInstances() {
        // Get current distribution
        const stats = this.getClusterStats();
        const avgInstancesPerCluster = stats.totalInstances / stats.healthyClusters;

        // Find overloaded clusters
        const overloadedClusters = stats.clusterDetails.filter(
            cluster => cluster.isHealthy && cluster.instanceCount > avgInstancesPerCluster * 1.5
        );

        // Find underloaded clusters
        const underloadedClusters = stats.clusterDetails.filter(
            cluster => cluster.isHealthy && cluster.instanceCount < avgInstancesPerCluster * 0.5
        );

        if (overloadedClusters.length > 0 && underloadedClusters.length > 0) {
            console.log('Redistribution needed', { overloadedClusters, underloadedClusters });

            // Emit redistribution event
            EMIT2('cluster-redistribution-needed', {
                overloaded: overloadedClusters,
                underloaded: underloadedClusters,
                average: avgInstancesPerCluster
            });
        }
    }

    shutdown() {
        if (this.healthTimer) {
            clearInterval(this.healthTimer);
        }
    }
}


class ManagerHub extends BootLoader {
    constructor(config = {}) {
        super(config);
        this.mincount = config.mincount || 4;
        this.maxcount = config.maxcount || 10;
        this.count = config.count || this.mincount;
        this.managers = {};
        this.createmanagers();
    }

    createmanagers() {
        for (var i = 0; i < this.count; i++) {
            let manager = new ClusterWhatsAppSessionManager({ index: i });
            this.managers[i] = manager;
            if (i == 0)
                MAIN.sessionManager = manager;
        }
        this.sethandlers();

        setTimeout(() => {
            this.emit('ready', this.managers);
        }, 1000);
    }

    getrandom() {
        const keys = Object.keys(this.managers);
        if (!keys.length)
            return null;
        const randomIndex = Math.floor(Math.random() * keys.length);
        return this.managers[keys[randomIndex]];
    }
    sethandlers() {
        this.on('restore', function (data) {
            let values = Object.values(this.managers);
            for (var value of values) {
                value.restore_session(data);
            }
        })
    }
}

class ClusterProxy {
    constructor(managerHub, config = {}) {
        this.managerHub = managerHub;
        this.config = config;
        this.clusterEndpoints = new Map();
        this.connections = MAIN.connections = new Map();
        this.setuplistenners();
    }

    registerClusterEndpoint(clusterId, endpoint) {
        this.clusterEndpoints.set(clusterId, endpoint);
    }

    async proxyRequest(phone, method, path, data) {
        const clusterId = this.managerHub.getClusterForInstance(phone);

        if (!clusterId) {
            throw new Error(`No cluster found for instance: ${phone}`);
        }

        const endpoint = this.clusterEndpoints.get(clusterId);
        if (!endpoint) {
            throw new Error(`No endpoint registered for cluster: ${clusterId}`);
        }

        // Here you would implement actual HTTP request proxying
        // This is a placeholder for the proxy logic
        return {
            clusterId,
            endpoint,
            method,
            path,
            data,
            // result: await httpRequest(endpoint + path, method, data)
        };
    }
    async getresponse(data, timeout) {
        return new Promise(function (resolve) {
            const reqid = UID();
            let responses = 0;

            let tm = setTimeout(() => {
                resolve(false);
            }, timeout || 30000);

            const callback = function (response) {
                if (response.reqid === reqid) {
                    responses++;
                    if (response.found) {
                        clearTimeout(tm);
                        resolve(response.response);
                    }
                }
            }
            ON('cluster-proxy-response', callback);
            EMIT2('cluster-proxy-request', { reqid, data });
        })
    }

    async setresponse(payload) {

        let data = payload.data;
        let reqid = payload.reqid;
        let clusterid = data.clusterId;
        let instance = MAIN.instances.get(data.params.phone);

        console.log('GREAT');
        if (clusterid == F.id && instance) {
            let schema = data.schema;
            let action = data.action;
            console.log('MATCH', instance);
            if (schema && action) {
                let builder = CALL(schema + ' --> ' + action, data.data);
                data.query && builder.query(data.query);
                data.params && builder.params(data.params);
                data.user && builder.user(data.user);
                builder.callback(function (err, res) {
                    if (!err) {
                        EMIT2('cluster-proxy-response', { clusterId: F.id, found: true, response: res, reqid });
                    }
                });

            }
        }
    }

    setconnection(phone, clusterid) {
        this.connections.set(phone, { clusterid: clusterid, local: clusterid == F.id });

        let local = clusterid == F.id;
        if (local)
            EMIT2('connection-ws-new', { clusterid: F.id, phone: phone });
    }

    async getconnection(phone) {
        return this.connections.get(phone);
    }

    async dropconnection(phone) {
        this.connections.delete(phone);
    }

    async setuplistenners() {
        ON('connection-ws-new', (data) => {
            this.setconnection(data.phone, data.clusterid);
        });

        ON('connection-ws-tx', (data) => {
            this.onws(data)
        });

        ON('cluster-proxy-request', (data) => {
            this.setresponse(data);
        })
    }

    async sendws(phone, data) {
        return new Promise(function (resolve) {
            let reqid = UID();
            let responses = 0;

            let tm = setTimeout(function () {
                resolve(false);
            }, 60000);
            const callback = function (response) {
                if (response.reqid == reqid) {
                    responses++;

                    if (response.found) {
                        clearTimeout(tm);
                        resolve(response.response);
                    }
                }
            }

            ON('connection-ws-rx', callback);
            EMIT2('connection-ws-tx', { reqid: reqid, data, phone });
        });
    }

    async onws(payload) {
        let data = payload.data;
        let reqid = payload.reqid;
        let clusterid = data.clusterId;
        let instance = MAIN.instances.get(payload.phone);
        let response = { found: false, reqid: reqid, response: {} };
        let msg = data.msg;

        if (clusterid == F.id && instance) {

            if (msg && msg.topic) {
                response.response.output = instance.message(msg);
            }

            if (msg && msg.type) {
                switch (msg.type) {
                    case 'text':
                        if (instance.state == 'open') {
                            instance.send_message(msg);
                        }
                        break;
                    case 'file':
                        if (instance.state == 'open') {
                            instance.send_file(msg);
                        }
                        break;

                }
            }

            response.response.clusterid = F.id;
            response.response.state = instance.state
            response.found = true;
            if (instance.state == 'open')
                response.response.success = true;
            else
                response.response.success = false;

            EMIT2('connection-ws-rx', response);
        }
    }

    async sendWithAck(event, payload = {}, config = {}) {
        const requestId = UID();
        payload.requestId = requestId;
        const ackEvent = `${event}_ack_${requestId}`;
        const timeout = config.timeout || 1000;
        const retries = config.retries || 0;

        return new Promise((resolve, reject) => {
            let attempt = 0;

            const trySend = () => {
                if (attempt > retries) {
                    OFF(ackEvent, handler);
                    return reject(new Error(`[ClusterProxy] ACK failed: ${event} after ${retries} retries`));
                }

                EMIT2(event, payload);
                attempt++;
                timer = setTimeout(trySend, timeout);
            };

            const handler = (response) => {
                let res = response.data

                if (!res) return;

                if (response.requestId == requestId && res.found) {
                    clearTimeout(timer);
                    OFF(ackEvent, handler);
                    resolve(response);
                };
            };


            if (ACK_LISTENERS.has(ackEvent)) {
                console.warn(`[ClusterProxy] Duplicate ACK listener on ${ackEvent}`);
                OFF(ackEvent, ACK_LISTENERS.get(ackEvent));
            }

            ACK_LISTENERS.set(ackEvent, handler);
            ON(ackEvent, handler);
            let timer = setTimeout(trySend, 0); // fire immediately
        });
    }

    async listenWithAck(event, handlerFn) {
        ON(event, async (payload) => {
            const requestId = payload.requestId;
            if (!requestId) return console.warn(`[ClusterProxy] Ignoring ${event} with no requestId`);

            try {
                const response = await handlerFn(payload);
                EMIT2(`${event}_ack_${requestId}`, {
                    requestId,
                    status: 'ok',
                    data: response
                });
            } catch (err) {
                EMIT2(`${event}_ack_${requestId}`, {
                    requestId,
                    status: 'error',
                    error: err.message || 'Handler error'
                });
            }
        });
    };

    async unwrap(response) {
        if (!response) throw new Error('[ClusterProxy] Empty response');
        if (response.status === 'ok') return response.data;
        throw new Error(response.error || '[ClusterProxy] Unknown ACK error');
    };

    async buildPayloadFromSchema($, model, schema, action) {
        return {
            clusterId: $.clusterId,
            schema: schema,
            action: action,
            params: $.params,
            query: $.query,
            data: model,
            model: model
        };
    };

    async callSchemaRemote ($, model, schema, action) {
        try {
            const payload = this.buildPayloadFromSchema($, model, schema, action);
            const response = await this.sendWithAck('cluster-schema-call', payload, { timeout: 30000, retries: 1 });
            let res = await this.unwrap(response);

            let output = {};
            output.succcess = true;
            if (res.data && res.data.output) {
                output.value = res.data.ouput;
            }

            return  output;
        } catch (err) {
            return { success: false, error: err.message };
        }
    };
}
ON('ready', function () {
    let hub = MAIN.hub = new ManagerHub();
    hub.on('ready', function () {
        U.ls(PATH.databases(), function (files, dirs) {
            var index = 0;
            files.wait(async function (file, next) {
                let name = file.split('databases')[1].substring(1);
                let is = name.match(/^memorize_\d+\.json/);
                if (is) {
                    F.Fs.readFile(PATH.databases(name), (err, data) => {
                        if (err) {
                            console.error("Error reading config file:", err);
                        } else {
                            if (index < 5) {
                                let parsed = JSON.parse(data);
                                hub.emit('restore', parsed);
                                index++;
                            }
                            console.log(`${name} read successfully.`);
                        }
                    });
                }

                next();
            }, function () {
                if (!MAIN.clusterproxy) 
                    MAIN.clusterproxy = new ClusterProxy();

                MAIN.clusterproxy.listenWithAck('proxy-ws-message', async function (payload) {
                    const { phone, msg, clusterId } = payload;
                    const instance = MAIN.instances.get(phone);
                    if (!instance || instance.state !== 'open') {
                        throw new Error(`[WS PROXY] No active instance for ${phone} on ${F.id}`);
                    }
                
                    const proxyId = `proxy-${clusterId}`;
                    if (!instance.ws_clients[proxyId]) {
                        instance.ws_clients[proxyId] = {
                            id: proxyId,
                            remote: true,
                            phone,
                            send: function (data) {
                                this.output = data;
                            }
                        };
                        console.log(`[SYNC] Registered proxy client ${proxyId} on ${F.id}`);
                    }
                
                    const proxyClient = instance.ws_clients[proxyId];
                
                    const fakeSocket = {
                        client: proxyClient,
                        send: function (output) {
                            proxyClient.output = output;
                        }
                    };
                
                    if (msg?.topic) {
                        instance.message(msg, fakeSocket);
                    } else if (msg?.type) {
                        if (instance && instance.state === 'open') instance.dispatch(msg);
                        fakeSocket.send({
                            success: instance.state === 'open',
                            state: instance.state,
                            clusterId: F.id
                        });
                    }
                    console.log(`[WS PROXY] Routed message to ${phone} on ${F.id}`);
                    return { output: proxyClient.output || { success: true } };
                });
              
            });
        });
    });
});

ON('cluster-broadcast-message', (data) => {
    if (data.targetCluster == this.clusterId || data.targetCluster == 'all') {
        if (data.event && data.event == 'ask') {
            let arr = MAIN.wsclients.get(data.phone) || [];
            arr.wait(async function(client, next) {
                console.log(client);
                client && client.send(data.message);
                next();
            });
        }
    }
});
ON('service', async function(tick) {
    if (tick % 60 === 0) {
    }
    DB().remove('db2/tbl_message').where('dtcreated', '<', NOW.add('-3 days')).where('kind', 'received').callback((err, res) => console.log('DELETED COUNT: ', res));
});