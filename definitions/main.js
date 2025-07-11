const makeWASocket = require('baileys').default;
const { useMultiFileAuthState, Browsers, DisconnectReason } = require('baileys');
const { RedisStore } = require('baileys-redis-store');
const { createClient } = require('redis');
const pino = require('pino');

// require terminal qr
const QRCode = require('qrcode');

const silentLogger = {
    info: console.log,
    warn: console.warn,
    error: console.error,
    trace: console.log,
    debug: console.log,
    child: () => silentLogger
};

async function create_client(id, t) {
    const redisClient = createClient({ url: CONF.redisUrl});
    redisClient.on('error', (err) => console.error('Redis Client Error:', err));
    await redisClient.connect();
    const store = new RedisStore({
        redisConnection: redisClient,
        prefix: id,
        logger: pino({ level: 'debug' }),
        maxCacheSize: 5000,
    });
    const authDir = 'databases/' + id;
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    t.authState = { state, saveCreds };
    t.store = store;
    t.redisClient = redisClient;
    const client = makeWASocket({
        auth: t.authState.state,
        browser: Browsers.macOS('Google Chrome'),
        getMessage: store.getMessage.bind(store)
    });
    await store.bind(client.ev);
    client.ev.on('creds.update', saveCreds);
    t.whatsapp = client;
    return client;
}

MAIN.Instance = function (phone, baseurl, origin = 'zapwize') {
    var t = this;
    t.db = DB();
    let filename = PATH.databases('memorize_' + phone + '.json');


    // check if memorize file exists, if not create it
    if (!Total.Fs.existsSync(filename)) { 
        Total.Fs.writeFileSync(filename, JSON.stringify(FUNC.getFormattedData(phone, baseurl), null, 2));
    }


    var w = t.memorize = MEMORIZE(phone);
    var data = w.data || {};
    data.id = UID();
    w.save();
    t.phone = phone;
    t.Worker = w;
    t.Data = data;
    t.id = data.id;
    t.ip = CONF.ip;
    t.port = CONF.port;
    t.plans = [];
    t.chats = [];
    t.messages = [];
    t.logs = [{ name: 'instance_created', content: true }];
    t.code = '';
    t.origin = origin;
    t.qrcode = '';
    t.is_maxlimit = false;
    t.is_limit = false;
    t.ws_clients = {};
    t.days = {};
    t.qr_retry = 0;
    t.qr_max_retry = 10;
    t.pairingCodeEnabled = true;
    t.pairingCodeRequested = false;
    t.reconnectAttempts = 0;
    t.maxReconnectAttempts = 5;
    t.reconnectDelay = 5000;

    // instead of onservice, we implement internal counter that is fired every 60 seconds
    t.tick = 0;
    t.tick2 = 0;
    t.tick_interval = 60;

    t.serviceInterval = setInterval(function () {
        t.tick2++;
        if (t.tick2 >= t.tick_interval) {
            t.tick2 = 0;
            t.tick++;
            t.onservice(t.tick);
        }
    }, 1000);
};

var IP = MAIN.Instance.prototype;

// Clean shutdown method
IP.shutdown = function() {
    var t = this;
    if (t.serviceInterval) {
        clearInterval(t.serviceInterval);
    }
    if (t.whatsapp) {
        t.whatsapp.end();
    }
};

// get code from whatsapp
IP.get_code = function () {
    var t = this;
    if (t.pairingCodeEnabled && !t.pairingCodeRequested) {
        t.PUB('code', { env: t.Worker.data, content: t.code });
    } else {
        t.PUB('qr', { env: t.Worker.data, content: t.qrcode });
    }
};

IP.ws_send = function (obj) {
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

IP.notify = function (obj) {
    var t = this;
    if (CONF.notify) {
        RESTBuilder.POST(CONF.notify.format(obj.topic), { title: obj.title }).keepalive().callback(NOOP);
    }
};

IP.save_revoked = async function (data) {
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
};

IP.laststate = function () {
    var t = this;
    var len = t.logs.length;
    return t.logs[len - 1];
};

IP.send = function (obj) {
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
};

IP.memory_refresh = function (body, callback) {
    var t = this;

    if (body) {
        for (var key in body)
            t.Worker.data[key] = body[key];
    }

    t.Worker.save();
    t.Worker = MEMORIZE(t.phone);
    callback && callback();
};

IP.setup_handlers = function () {
    var t = this;
    t.set_handlers();
};

IP.init = async function () {
    var t = this;
    try {
        await create_client(t.phone, t);
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
        t.setup_handlers();

        t.resetInstance = async function () {
            try {
                t.pairingCodeRequested = false;
                t.PUB('instance_restarted', { content: true });
            } catch (err) {
                console.error('Error restarting instance:', err);
            }
        };
        
        t.restartInstance = async function () {
            try {
                t.pairingCodeRequested = false;
                t.whatsapp.end();
                await new Promise(resolve => setTimeout(resolve, 2000));
                await create_client(t.phone, t);
                t.setup_handlers();
                t.PUB('instance_reset', { content: true });
            } catch (err) {
                console.error('Error resetting instance:', err);
            }
        };

        // Setup routes
        ROUTE('+POST /api/config/' + t.phone, function (phone) {
            var self = this;
            var body = self.body;
            t.memory_refresh(body, function () {
                self.success();
            });
        });

        ROUTE('+GET /api/config/' + t.phone, function (phone) {
            var self = this;
            self.json(t.Data);
        });

        ROUTE('+POST /api/rpc/' + t.phone, function (phone) {
            var self = this;
            var payload = self.body;
            self.ws = false;
            t.message(payload, self);
        }); 

        ROUTE('+POST ' + (t.Data.messageapi || '/api/send/') + t.phone, function () {
            var self = this;
            console.log(self.body);
            if (t.state == 'open') {
                t.sendMessage(self.body);
                t.usage(self);
            }
            self.success();
        });

        ROUTE('+POST ' + (t.Data.mediaapi || '/api/media/') + t.phone, function () {
            var self = this;
            console.log(self.body);
            if (t.state == 'open') {
                t.send_file(self.body);
                t.usage(self);
            }
            self.success();
        });

        // Websocket server
        ROUTE('+SOCKET /api/ws/' + t.phone, function (phone) {
            var self = this;
            var socket = self;
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
                                t.sendMessage(msg);
                            }
                            break;
                        case 'file':
                            if (t.state == 'open') {
                                t.send_file(msg);
                            }
                            break;
                    }
                    client.send({ success: true });
                }
            });
            
            socket.on('disconnect', function (client) {
                console.log('Client disconnected:', client.id);
                delete t.ws_clients[client.id];
            });
        });

        setTimeout(function () {
            console.log('Initializing whatsapp: ' + t.id);
            t.logs.push({ name: 'instance_initializing', content: 'ID:' + t.id });
        }, 500);
        
    } catch (err) {
        console.error('Error initializing instance:', err);
        t.logs.push({ name: 'instance_error', content: err.message });
    }
};

IP.set_handlers = function () {
    var t = this;
    
    // Save credentials on update
    t.whatsapp.ev.on('creds.update', t.authState.saveCreds);
    
    t.whatsapp.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        t.state = connection;
        if (connection === 'open') {
            t.reconnectAttempts = 0; // Reset reconnect attempts on successful connection
            t.logs.push({ name: 'whatsapp_ready', content: true });
            t.PUB('ready', { env: t.Worker.data, content: true });
            t.save_session();
            t.get_code();
            t.refresh_plans();
            t.PUB('instance_online', { env: t.Worker.data, content: true });
            t.online = true;
            console.log('WhatsApp is ready: ' + t.phone);

        } else if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed, shouldReconnect:', shouldReconnect);
            
            if (shouldReconnect && t.reconnectAttempts < t.maxReconnectAttempts) {
                t.reconnectAttempts++;
                console.log(`Reconnecting... attempt ${t.reconnectAttempts}/${t.maxReconnectAttempts}`);
                
                setTimeout(async () => {
                    try {
                        t.whatsapp = await create_client(t.phone, t);
                        t.setup_handlers();
                    } catch (err) {
                        console.error('Reconnection failed:', err);
                    }
                }, t.reconnectDelay * t.reconnectAttempts);
            } else if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
                console.log('Device logged out, stopping reconnection attempts');
                t.logs.push({ name: 'whatsapp_logged_out', content: true });
                t.PUB('logged_out', { env: t.Worker.data, content: true });
            }
        }

        // handle qr code
        if (qr) {
            t.qrcode = qr;
            console.log('QR Code received:', qr);
            //console.log(await QRCode.toString(qr, {type:'terminal'}));
            t.qr_retry++;
            // print QR code in terminal
            QRCode.toString(qr, { type: 'terminal', small: true }, (err, qrString) => {
                if (err) {
                    console.error('Error generating QR code:', err);
                } else {
                    console.log('QR Code:\n' + qrString);
                }
            });

            if (t.qr_retry > t.qr_max_retry) {
                t.logs.push({ name: 'whatsapp_qr_max_retry', content: true });
                t.PUB('qr_max_retry', { env: t.Worker.data, content: true });
                return;
            }

            if (t.pairingCodeEnabled && !t.pairingCodeRequested) {
               // request pairing code after a delay
                setTimeout(async () => {
                     try {
                    t.code = await t.whatsapp.requestPairingCode(t.phone);
                    t.pairingCodeRequested = true;
                    console.log(t.phone + ': Pairing code requested: ' + t.code);
                } catch (err) {
                    console.error('Error requesting pairing code:', err);
                }
                }, 3000);
            }
            
            t.get_code();
            t.logs.push({ name: 'whatsapp_qr', content: true });
            t.PUB('qr', { env: t.Worker.data, content: qr });
        }
    });

    // on presence update
    t.whatsapp.ev.on('presence.update', async (update) => {
        try {
            const { id, presences } = update;
            const presence = presences[id];
            if (presence) {
                t.logs.push({ name: 'whatsapp_presence_update', content: presence });
                t.PUB('presence_update', { env: t.Worker.data, content: presence });
            }
        } catch (err) {
            console.error('Error handling presence update:', err);
        }
    });

    // on receive all chats
    t.whatsapp.ev.on('chats.set', async (update) => {
        try {
            const chats = update.chats;
            let received_chats = [];
            
            for (var i = 0; i < chats.length; i++) {
                var chat = chats[i];
                chat.messages = [];
                if (chat.isGroup) {
                    try {
                        var group = await t.whatsapp.groupMetadata(chat.id);
                        chat.group = group;
                    } catch (err) {
                        console.error('Error getting group metadata:', err);
                    }
                }
                received_chats.push(chat);
            }

            t.chats = received_chats;
            t.Worker.data.chats = received_chats;
            t.Worker.save();
            t.logs.push({ name: 'whatsapp_chats_loading', content: true });
            console.log('Chats loaded: ' + t.chats.length);
            t.PUB('chats_loading', { env: t.Worker.data, content: true });
        } catch (err) {
            console.error('Error handling chats.set:', err);
        }
    });

    // on chat delete
    t.whatsapp.ev.on('chats.delete', async (update) => {
        try {
            const chats = update.chats;
            for (var i = 0; i < chats.length; i++) {
                var chat = chats[i];
                t.chats = t.chats.filter(c => c.id != chat.id);
            }
            t.Worker.data.chats = t.chats;
            t.Worker.save();
            t.logs.push({ name: 'whatsapp_chats_delete', content: true });
            console.log('Chats deleted: ' + chats.length);
            t.PUB('chats_delete', { env: t.Worker.data, content: true });
        } catch (err) {
            console.error('Error handling chats.delete:', err);
        }
    });

    // on new message
    t.whatsapp.ev.on('messages.upsert', async (m) => {
        try {
            if (m.type === 'prepend') {
                t.messages.unshift(...m.messages);
                return;
            }

            if (m.type !== 'notify') {
                return;
            }

            // if send read receipt
            if (t.Worker.data.markMessagesRead) {
                const unreadMessages = m.messages.map((msg) => {
                    return {
                        remoteJid: msg.key.remoteJid,
                        id: msg.key.id,
                        participant: msg.key?.participant,
                    }
                });
                await t.whatsapp.readMessages(unreadMessages);
            }

            t.messages.unshift(...m.messages);

            // Process messages
            for (let msg of m.messages) {
                if (!msg.message) continue;

                const messageType = Object.keys(msg.message)[0];
                const webhookData = {
                    key: t.phone,
                    ...msg,
                };

                if (messageType === 'conversation') {
                    webhookData['text'] = msg.message.conversation;
                    t.PUB('message', { env: t.Worker.data, content: webhookData });
                }

                switch (messageType) {
                    case 'imageMessage':
                        if (FUNC && FUNC.downloadMessage) {
                            webhookData['content'] = await FUNC.downloadMessage(
                                msg.message.imageMessage,
                                'image'
                            );
                        }
                        break;
                    case 'videoMessage':
                        if (FUNC && FUNC.downloadMessage) {
                            webhookData['content'] = await FUNC.downloadMessage(
                                msg.message.videoMessage,
                                'video'
                            );
                        }
                        break;
                    case 'audioMessage':
                        if (FUNC && FUNC.downloadMessage) {
                            webhookData['content'] = await FUNC.downloadMessage(
                                msg.message.audioMessage,
                                'audio'
                            );
                        }
                        break;
                    default:
                        webhookData['content'] = '';
                        break;
                }

                // Save to database
                await t.saveMessageToDatabase(msg);
            }
        } catch (err) {
            console.error('Error handling messages.upsert:', err);
        }
    });

    // on message delete
    t.whatsapp.ev.on('messages.delete', async (m) => {
        try {
            for (let msg of m.messages) {
                if (!msg.key) continue;

                const messageType = Object.keys(msg.message || {})[0];
                const webhookData = {
                    key: t.phone,
                    ...msg,
                };

                // Save deleted message to database
                await t.saveMessageToDatabase(msg, true);
                
                if (msg.type == 'revoked') {
                    await t.save_revoked(msg);
                }
            }
        } catch (err) {
            console.error('Error handling messages.delete:', err);
        }
    });
};

IP.saveMessageToDatabase = async function(msg, isDeleted = false) {
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
};

IP.PUB = function (topic, obj, broker) {
    var t = this;
    obj.env = t.Worker.data;
    obj.topic = topic;
    console.log('PUB: ' + topic, obj.content);
    t.send(obj);
};

IP.refresh_plans = async function () {
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
};

IP.refresh_days = function (key) {
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
};

IP.usage = async function ($, next) {
    var t = this;
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
};

IP.refresh_limits = async function () {
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
};

IP.save_session = async function () {
    var t = this;
    var cl = t.memorize.data.cl;
    if (cl) {
        // try to check if remote browser has been successfully created
        var sessionurl = cl.baseurl + 'sessions/?token=' + cl.token;
        console.log('Browserless session url: ' + sessionurl);
        var page;
        var browser;
        RESTBuilder.GET(sessionurl).callback(function (err, sessions) {
            console.log('Browserless session: ' + sessions);
            sessions && sessions.wait(async function (item, next) {
                if (item.type == 'browser' && item.trackingId == t.phone && item.running)
                    browser = item;

                if (item.type == 'page' && item.trackingId == t.phone && item.title.includes('WhatsApp'))
                    page = item;

                next();
            }, async function () {
                if (browser && page) {
                    var data = {};
                    data.id = browser.id;
                    data.url = cl.url
                    data.type = cl.type;
                    data.hostname = cl.baseurl;
                    data.datadir = browser.userDataDir;
                    data.killurl = replaceHostname(browser.killURL, cl.baseurl);
                    data.dtcreated = NOW;
                    await t.db.insert('tbl_browserless', data).promise();
                    t.browserid = browser.id;
                    t.browser = browser;
                    t.memorize.data.browser = browser;
                    t.memorize.data.cl = cl;
                    t.memorize.save();
                    //console.log('Browserless session created: ' + t.phone);
                    t.PUB('browserless', { env: t.Worker.data, content: browser });
                    console.log('Browserless session created: ' + t.phone);
                }
            });
            // check if browser exists and page.title includes 'WhatsApp'

        });
    }
};
IP.ask = async function (number, chatid, content, type, isgroup, istag, user, group) {
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
    // if (t.Data.webhook) {
    // RESTBuilder.POST(t.Data.webhook, { type: CONF.antidel ? 'message_revoke_everyone' : 'message', data: obj }).header('x-token', t.Data.token).header('token', t.Data.token).callback(NOOP);
    // }
    if (t.origin == 'zapwize') {
        t.ws_send(obj);
    }
};

IP.sendMessage = async function (data) {
    if (data.chatid.indexOf('@') == -1) {
        var isphone = data.chatid.isPhone();

        if (isphone)
            data.chatid = data.chatid + '@c.us';
        else
            data.chatid = data.chatid + '@g.us';
    }
    this.whatsapp && await this.whatsapp.sendMessage(data.chatid, data.content);
};


IP.send_file = async function (data) {
    var t = this;
    var media;
    if (data.chatid.indexOf('@') == -1) {
        var isphone = data.chatid.isPhone();

        if (isphone)
            data.chatid = data.chatid + '@c.us';
        else
            data.chatid = data.chatid + '@g.us';
    }

    if (data.url)
        media = await MessageMedia.fromUrl(data.url);
    else
        media = new MessageMedia(data.content.base64ContentType(), data.content);

    if (data.caption)
        t.whatsapp && media && await t.whatsapp.sendMessage(data.chatid, media, { caption: data.caption });
    else
        t.whatsapp && media && await t.whatsapp.sendMessage(data.chatid, media);
};

IP.message = async function (msg, ctrl) {
    var t = this;
    var output = { reqid: UID() };
    var reqid = msg.reqid || UID();
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
};

IP.save_file = async function (data, callback) {
    var obj = {};
    obj.name = GUID(35) + data.ext;
    obj.file = data.content;
    var fs = FILESTORAGE(data.number);

    var id = data.custom.dp;
    fs.save(id || UID(), obj.name, obj.file.base64ToBuffer(), function (err, meta) {
        meta.url = '/' + data.number + '/download/{0}.{1}'.format(meta.id.sign(CONF.salt), meta.ext);
        //callback && callback(meta);
    }, data.custom, CONF.ttl);
};


IP.onservice = function (tick) {
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
};



