const { downloadContentFromMessage } = require('baileys')

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