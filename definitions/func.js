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
FUNC.getFormattedData = function (phone, baseurl) {

    let data =  {
        name: 'Muald',
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
        id: data.id
    }
};

FUNC.handle_textonly = async function (message, self, conn) {
    const contentType = getContentType(message.message);
    if (message.key?.remoteJid?.includes("status@broadcast")) return;
    if (contentType !== "conversation" && contentType !== "extendedTextMessage") return;

    const number = message.key.remoteJid.split("@")[0];
    const chatid = message.key.remoteJid;
    const fromMe = message.key.fromMe;
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
            message.body = `"${quotedBody.substring(0, 2200)}": \n\n\n\n${body}`;
        }
    }

    const body = message.message.extendedTextMessage?.text || message.message.conversation;

    if (self.Data.sendtyping)
        await conn.sendPresenceUpdate('composing', chatid);

    if (body)
        self.ask(user.number, chatid, body, 'text', isgroup, istag, user, group);
};

FUNC.send_seen = async function (message, conn) {
    const chatid = message.key.remoteJid;
    // await conn.sendReadReceipt(chatid, message.key.participant || message.key.remoteJid, [message.key.id]);
};

FUNC.handle_voice = async function (message, self, conn) {
    const chatid = message.key.remoteJid;
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
        self.ask(user.number, chatid, response, 'voice', isgroup, false, user, group);
    });
};

FUNC.handle_media = async function (message, self, conn) {
    const chatid = message.key.remoteJid;
    const number = chatid.split('@')[0];
    const isgroup = chatid.includes('@g.us');
    const sender = isgroup ? message.key.participant : chatid;
    const user = {};
    const group = {};

    const mtype = getContentType(message.message);
    if (mtype === 'imageMessage' || mtype === 'audioMessage') return; // Filter only video/docs/others

    if (mtype == "conversation" || mtype == "extendedTextMessage") return;

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
        custom: { type: getCustomTypeByExtension(ext), fromstatus: false }
    };

    if (caption)
        data.caption = caption;

    self.save_file(data, function (response) {
        self.ask(user.number, chatid, response, 'file', isgroup, false, user, group);
    });
};

FUNC.handle_image = async function (message, self, conn) {
    const chatid = message.key.remoteJid;
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
        self.ask(user.number, chatid, response, 'image', isgroup, false, user, group);
    });
};

FUNC.handle_status = async function (message, self, conn) {
    const chatid = message.key.remoteJid;
    if (!chatid.includes('status@broadcast')) return;

    const number = chatid.split('@')[0];
    const isgroup = false;
    const user = { chatid, number };
    const group = {};
    const mtype = getContentType(message.message);
    const media = mtype && (await downloadMediaMessage(message, 'buffer', {}, { reuploadRequest: conn.updateMediaMessage }));

    if (media) {
        const mimetype = message.message[mtype]?.mimetype;
        const content = 'data:' + mimetype + ';base64,' + media.toString('base64');
        const data = {
            content: content,
            ext: '.' + U.getExtensionFromContentType(mimetype),
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
