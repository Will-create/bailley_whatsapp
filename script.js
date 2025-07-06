const { makeWASocket, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (text) => new Promise((resolve) => rl.question(text, resolve));

// Prevent reconnect loop
let hasReconnected = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info2');

    const sock = makeWASocket({
        auth: state,
        browser: ['Mac OS', 'Chrome', '119.0.0.0'],
        printQRInTerminal: false,
        markOnlineOnConnect: true,
    });

    sock.ev.on('creds.update', async () => await saveCreds());

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log('\n✅ Connection successfully established.\n');
            rl.close();
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log('\n⚠️ Connection closed:', lastDisconnect?.error?.message || 'Unknown error');
            if (code === 515) {
                console.error('💣 WhatsApp blocked the session (code 515). Review fingerprint and pairing method.');
            }

            if (!hasReconnected) {
                hasReconnected = true;
                console.log('🕒 Reconnecting in 5 seconds...');
                setTimeout(() => connectToWhatsApp(), 5000);
            } else {
                console.error('❌ Reconnect failed. Manual intervention required.');
                process.exit(1);
            }
        }
    });

    if (!sock.authState.creds.registered) {
        const rawNumber = await ask('📱 Enter your phone number in international format:\n');
        const sanitized = rawNumber.replace(/\D/g, '').replace(/^0+/, '');

        if (sanitized.length < 10 || sanitized.length > 15) {
            console.error('❌ Invalid phone number.');
            rl.close();
            return;
        }

        console.log('⏳ Waiting 10 seconds before requesting pairing code...');
        await new Promise(res => setTimeout(res, 10000));

        try {
            const pairingCode = await sock.requestPairingCode(sanitized);
            const formatted = pairingCode.length === 8 ? pairingCode.slice(0, 4) + '-' + pairingCode.slice(4) : pairingCode;
            console.log(`\n🔢 Enter this code in WhatsApp: ${formatted}`);
        } catch (error) {
            console.error('❌ Failed to request pairing code:', error?.message || error);
        }
    } else {
        console.log('✅ Already registered with WhatsApp.');
        rl.close();
    }
}

process.on('SIGINT', () => {
    console.log('\n🛑 Shutdown requested.');
    process.exit(0);
});

connectToWhatsApp();
