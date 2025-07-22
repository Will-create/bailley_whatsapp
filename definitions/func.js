const { getContentType, downloadMediaMessage, downloadContentFromMessage } = require('@whiskeysockets/baileys');

FUNC.downloadMessage = async function (msg, msgType) {
    let buffer = Buffer.from([])
    try {
        const stream = await downloadContentFromMessage(msg, msgType)
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk])
        }
    } catch {
        return console.log('error downloading file-message')
    }
    return buffer.toString('base64')
};


FUNC.getCustomTypeByExtension = function(extension) {

    const videoExtensions = [
      'mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'mpeg', 'mpg', '3gp', 'm4v'
    ];
  
    const documentExtensions = [
      'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'rtf', 'odt', 'ods', 'odp'
    ];
  
    const otherExtensions = [
      'zip', 'rar', '7z', 'apk', 'exe', 'dmg', 'tar', 'gz', 'iso', 'bin', 'jar', 'msi', 'xz', 'deb'
    ];
  
    if (videoExtensions.includes(extension)) {
      return 'video';
    }
  
    if (documentExtensions.includes(extension)) {
      return 'document';
    }
  
    if (otherExtensions.includes(extension)) {
      return 'other';
    }
  
    return 'other'; // default fallback
  }
  


FUNC.generateVC = function (data) {
    const result =
        'BEGIN:VCARD\n' +
        'VERSION:3.0\n' +
        `FN:${data.fullName}\n` +
        `ORG:${data.organization};\n` +
        `TEL;type=CELL;type=VOICE;waid=${data.phoneNumber}:${data.phoneNumber}\n` +
        'END:VCARD'

    return result
}

FUNC.sleep = function (ms) {
    return new Promise((resolve) => {
        let timeout = setTimeout(function() {
            console.log('Sleeping for ' + ms + 'ms')
            clearInterval(timeout);
            resolve();
        }, ms);
    })
};

FUNC.processButton = function (buttons) {
    const preparedButtons = []
    buttons.map((button) => {
        if (button.type == 'replyButton') {
            preparedButtons.push({
                quickReplyButton: {
                    displayText: button.title ?? '',
                },
            });
        }

        if (button.type == 'callButton') {
            preparedButtons.push({
                callButton: {
                    displayText: button.title ?? '',
                    phoneNumber: button.payload ?? '',
                },
            })
        }
        if (button.type == 'urlButton') {
            preparedButtons.push({
                urlButton: {
                    displayText: button.title ?? '',
                    url: button.payload ?? '',
                },
            })
        }
    })
    return preparedButtons;
};


// {
// 	"data": {
// 		"name": "Muald",
// 		"mode": "code",
// 		"baseurl": "https://whatsapp.muald.com",
// 		"phone": "22650777706",
// 		"messageapi": "/api/message/",
// 		"mediaapi": "/api/media/",
// 		"rpc": "/api/rpc/",
// 		"webhook": "https://api.muald.com/proxy/admin/webhook/",
// 		"id": "1jns8001sn51d",
// 		"status": "active",
// 		"sendseen": false,
// 		"sendtyping": false,
// 		"sendrecording": false
// 	},
// 	"id": "1jns8001sn51d"
// }


// FUNC fn to return formatted data from the above object with only phone
FUNC.getFormattedData = function (phone, baseurl, managerid) {

    let data =  {
        name: 'Muald',
        managerid: managerid,
        clusterid: F.id,
        mode: 'code',
        token: CONF.token || GUID(35),
        baseurl: baseurl || 'https://whatsapp.muald.com',
        phone: phone,
        messageapi: '/api/message/',
        mediaapi: '/api/media/',
        rpc: '/api/rpc/',
        webhook: 'https://api.muald.com/proxy/admin/webhook/',
        id: UID(),
        status: 'active',
        sendseen: false,
        sendtyping: false,
        sendrecording: false
    }

    return {
        data: data,
        id: data.id,
        clusterid: data.clusterid,
        managerid: data.managerid,
        phone: phone
    }
};

FUNC.handle_textonly = async function (message, self, conn) {
    const contentType = getContentType(message.message);
    let msgid = message.key.id;
    if (message.key?.remoteJid?.includes("status@broadcast")) return;
    const allowedTypes = ['conversation', 'extendedTextMessage'];
    if (!allowedTypes.includes(contentType)) return;
    const number = message.key.remoteJid.split("@")[0];
    const chatid = message.key.remoteJid;
    const fromMe = number == self.phone;
    const isgroup = chatid.includes("@g.us");
    const user = {};
    const group = {};
    const sender = isgroup ? message.key.participant || message.participant : message.key.remoteJid;
    const pushName = message.pushName || "Unknown";
    
    const mentions = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const istag = mentions.includes(conn.user.id);

    user.id = sender;
    user.number = sender.split("@")[0];
    user.pushname = pushName;
    user.countrycode = await FUNC.getCountryCode(user.number);

    group.id = isgroup ? chatid : "";
    group.name = ""; // Manual lookup needed if you want group names

    const context = message.message?.extendedTextMessage?.contextInfo;
    if (context?.quotedMessage) {
        const quotedBody = context.quotedMessage.conversation || context.quotedMessage.extendedTextMessage?.text;
        if (quotedBody) {
            const body = message.message.extendedTextMessage?.text || message.message.conversation;
            message.quoted = quotedBody;
        }
    }

    const body = message.message.extendedTextMessage?.text || message.message.conversation;

    self.Data.sendtyping && await conn.sendPresenceUpdate('composing', chatid);

    if (body)
        self.ask(user.number, chatid, body, 'text', isgroup, istag, user, group, {msgid, viewonce: false });
};

FUNC.send_seen = async function (message, conn) {
    const chatid = message.key.remoteJid;
    // await conn.sendReadReceipt(chatid, message.key.participant || message.key.remoteJid, [message.key.id]);
};

FUNC.handle_voice = async function (message, self, conn) {
    const chatid = message.key.remoteJid;
    let msgid = message.key.id;
    if (!chatid.includes('status@broadcast')) return;

    const number = chatid.split('@')[0];
    const isgroup = chatid.includes('@g.us');
    const sender = isgroup ? message.key.participant : chatid;
    const user = {};
    const group = {};

    const mtype = getContentType(message.message);
    if (mtype !== 'audioMessage') return;

    const audio = await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: conn.updateMediaMessage });
    const mimetype = message.message.audioMessage?.mimetype;

    if (mimetype !== 'audio/ogg; codecs=opus') return;

    user.id = sender;
    user.number = sender.split("@")[0];
    user.pushname = message.pushName || 'Unknown';
    user.countrycode = await FUNC.getCountryCode(user.number);

    group.id = isgroup ? chatid : '';
    group.name = ''; // Group name unavailable directly

    if (self.Data.sendrecording)
        await conn.sendPresenceUpdate('recording', chatid);

    const content = 'data:' + mimetype + ';base64,' + audio.toString('base64');

    const data = {
        content: content,
        ext: '.ogg',
        number: user.number,
        id: message.key.id,
        custom: { type: 'voice' }
    };

    
    self.save_file(data, function (response) {
        self.ask(user.number, chatid, response, 'voice', isgroup, false, user, group, {msgid, viewonce: false });
    });
};

FUNC.handle_media = async function (message, self, conn) {
    const chatid = message.key.remoteJid;
    let msgid = message.key.id;
    if (!chatid.includes('status@broadcast')) return;

    const number = chatid.split('@')[0];
    const isgroup = chatid.includes('@g.us');
    const sender = isgroup ? message.key.participant : chatid;
    const user = {};
    const group = {};
    const mtype = getContentType(message.message);
    const allowedTypes = ['videoMessage', 'documentMessage'];
    if (!allowedTypes.includes(mtype)) return;

    const media = await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: conn.updateMediaMessage });
    const mimetype = message.message[mtype]?.mimetype;
    const caption = message.message[mtype]?.caption;

    user.id = sender;
    user.number = sender.split("@")[0];
    user.pushname = message.pushName || 'Unknown';
    user.countrycode = await FUNC.getCountryCode(user.number);

    group.id = isgroup ? chatid : '';
    group.name = '';

    if (self.Data.sendrecording)
        await conn.sendPresenceUpdate('recording', chatid);

    const ext = U.getExtensionFromContentType(mimetype);
    const content = 'data:' + mimetype + ';base64,' + media.toString('base64');

    const data = {
        content: content,
        ext: '.' + ext,
        number: user.number,
        id: message.key.id,
        custom: { type: FUNC.getCustomTypeByExtension(ext), fromstatus: false }
    };

    if (caption)
        data.caption = caption;

    self.save_file(data, function (response) {
        self.ask(user.number, chatid, response, data.custom.type, isgroup, false, user, group, {msgid});
    });
};

FUNC.handle_image = async function (message, self, conn) {
    const chatid = message.key.remoteJid;
    console.log('[LOUIS BERTSON] IMAGE', message);
    let msgid = message.key.id;
    if (!chatid.includes('status@broadcast')) return;

    const number = chatid.split('@')[0];
    const isgroup = chatid.includes('@g.us');
    const sender = isgroup ? message.key.participant : chatid;
    const user = {};
    const group = {};

    const mtype = getContentType(message.message);
    if (mtype !== 'imageMessage') return;

    const media = await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: conn.updateMediaMessage });
    const mimetype = message.message.imageMessage?.mimetype;
    const caption = message.message.imageMessage?.caption;

    user.id = sender;
    user.number = sender.split("@")[0];
    user.pushname = message.pushName || 'Unknown';
    user.countrycode = await FUNC.getCountryCode(user.number);

    group.id = isgroup ? chatid : '';
    group.name = '';

    const content = 'data:' + mimetype + ';base64,' + media.toString('base64');

    const data = {
        content: content,
        ext: '.jpg',
        number: user.number,
        id: message.key.id,
        custom: { type: 'image', fromstatus: false, caption: caption }
    };

    self.save_file(data, function (response) {
        if (caption) response.caption = caption;
        self.ask(user.number, chatid, response, 'image', isgroup, false, user, group, {msgid});
    });
};

FUNC.handle_status = async function (message, self, conn) {
    let chatid = message.key.remoteJid;
    let msgid = message.key.id;
    if (!chatid.includes('status@broadcast')) return;

    chatid = message.key.participant;

    console.log('[STATUS]: ', message);
    const number = chatid.split('@')[0];
    const isgroup = false;
    const user = { chatid, number };
    user.pushname = message.pushName || 'Unknown';
    user.countrycode = await FUNC.getCountryCode(user.number);

    const group = {};
    
    const mtype = getContentType(message.message);
    console.log('[LOUIS BERTSON]: ', mtype);
    const allowedTypes = ['videoMessage', 'documentMessage', 'imageMessage', 'audioMessage', 'conversation', 'extendedTextMessage'];
    if (!allowedTypes.includes(mtype)) return;

    const hasmedia = await FUNC.hasmedia(message);
    if (hasmedia) {
        const media = mtype && (await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: conn.updateMediaMessage }));
        const mimetype = message.message[mtype]?.mimetype;
        const content = 'data:' + mimetype + ';base64,' + media.toString('base64');
        const data = {
            content: content,
            ext: mtype == 'audioMessage' ? '.ogg' : '.' + U.getExtensionFromContentType(mimetype),
            number: number,
            id: message.key.id,
            custom: { type: 'status', fromstatus: true }
        };
        if (message.message[mtype]?.caption)
            data.custom.caption = message.message[mtype].caption;

        self.save_file(data, function (response) {
            response.body = message.message[mtype]?.caption || '';
            self.ask(number, chatid, response, 'status', false, false, user, group, { msgid });
        });
    } else {
        const model = {
            body: message.message.conversation || '',
            caption: '',
            media: null
        };
        self.ask(number, chatid, model, 'status', false, false, user, group, {msgid});
    }
};


FUNC.wsonmessage = function(instance, client, msg) {
    if (msg && msg.topic) {
        self.client = client;
        instance.message(msg, self);
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
            case 'cluster-broadcast':
                // Handle cluster-wide broadcasts
                if (msg.broadcast && instance.state == 'open') {
                    instance.emit('cluster-message', {
                        message: msg.data,
                        broadcast: true,
                        targetCluster: msg.targetCluster || 'all'
                    });
                }
                break;
        }
        
        
    }
}

FUNC.hasmedia = async function (message) {
    if (!message || !message.message) return false;

    const mtype = getContentType(message.message);

    // Skip known non-media types
    const nonMediaTypes = [
        'conversation',
        'extendedTextMessage',
        'protocolMessage',
        'senderKeyDistributionMessage',
        'reactionMessage',
        'pollCreationMessage',
        'pollUpdateMessage'
    ];

    if (nonMediaTypes.includes(mtype)) return false;

    // Valid media types
    const mediaTypes = [
        'imageMessage',
        'videoMessage',
        'audioMessage',
        'documentMessage',
        'stickerMessage',
        'viewOnceMessageV2', // sometimes used for disappearing media
    ];

    return mediaTypes.includes(mtype);
};


FUNC.handle_revoked = async function (message, self, conn) {
    let chatid = message.key.remoteJid;
    if (!chatid.includes('status@broadcast')) return;

    chatid = message.key.participant;

    console.log('[STATUS]: ', message);
    const number = chatid.split('@')[0];
    const isgroup = false;
    const user = { chatid, number };
    user.pushname = message.pushName || 'Unknown';
    user.countrycode = await FUNC.getCountryCode(user.number);

    const group = {};
    
    const mtype = getContentType(message.message);
    console.log('[LOUIS BERTSON]: ', mtype);
    const allowedTypes = ['videoMessage', 'documentMessage', 'imageMessage', 'audioMessage', 'conversation', 'extendedTextMessage'];
    if (!allowedTypes.includes(mtype)) return;

    const hasmedia = await FUNC.hasmedia(message);
    if (hasmedia) {
        const media = mtype && (await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: conn.updateMediaMessage }));
        const mimetype = message.message[mtype]?.mimetype;
        const content = 'data:' + mimetype + ';base64,' + media.toString('base64');
        const data = {
            content: content,
            ext: mtype == 'audioMessage' ? '.ogg' : '.' + U.getExtensionFromContentType(mimetype),
            number: number,
            id: message.key.id,
            custom: { type: 'status', fromstatus: true }
        };
        if (message.message[mtype]?.caption)
            data.custom.caption = message.message[mtype].caption;

        self.save_file(data, function (response) {
            response.body = message.message[mtype]?.caption || '';
            self.ask(number, chatid, response, 'status', false, false, user, group);
        });
    } else {
        const model = {
            body: message.message.conversation || '',
            caption: '',
            media: null
        };
        self.ask(number, chatid, model, 'status', false, false, user, group);
    }
};