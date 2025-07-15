// ON('ready', async function () {
//     const manager = new MAIN.WhatsAppSessionManager({
//         redisUrl: CONF.redisUrl,
//         authDir: 'databases',
//         maxInstances: 100
//     });

//     process.on('SIGINT', async () => {
//         console.log('Shutting down session manager...');
//         await manager.gracefulShutdown();
//         process.exit(0);
//     });

//     async function initializeInstance(phone, config = {}) {
//         try {
//             const instance = await manager.createInstance(phone, { ...CONF, ...config });
//             console.log(`[${phone}] Instance created: ${instance.id}`);

//             instance.on('pairing-code', d => console.log(`[${d.phone}] Pairing Code: ${d.code}`));
//             instance.on('qr', qr => console.log(`[${instance.phone}] QR:`, qr));
//             instance.on('ready', () => console.log(`[${instance.phone}] Ready ✅`));
//             instance.on('message', msg => console.log(`[${instance.phone}] Message:`, msg));
//             instance.on('logged-out', () => console.warn(`[${instance.phone}] Logged out.`));
//             instance.on('error', err => console.error(`[${instance.phone}] Error:`, err));
//             instance.on('shutdown', (reason) => console.log(`[${instance.phone}] Shutdown.${reason}`));
//             instance.on('ask', (obj) => console.log(`[${instance.phone}] Reconnecting...`, obj));


//             return instance;
//         } catch (err) {
//             console.error(`❌ Init failed for ${phone}:`, err);
//             throw err;
//         }
//     }

//     // Register instance
//     const registered = '22655416464';
//     const receiver = '22656920671@s.whatsapp.net';

//     const instance = await initializeInstance(registered, { usePairingCode: true });

//     instance.on('ready', async () => {
//         // Send text message
//         await instance.send_message({
//             chatid: receiver,
//             content: '🔥 This is a test message from FUNC_BAILEYS.sendMessage().'
//         });

//         // Send image
//         await instance.send_file({
//                 chatid: receiver,
//                 type: 'url',
//                 url: 'https://fs.zapwize.com/files/22656920671/1n23c001ri51d-pp.jpg',
//                 caption: '🖼️ Test image from Baileys wrapper'
//             }
//         );

//         // Send PDF
//         await instance.send_file({
//                 chatid: receiver,
//                 type: 'url',
//                 url: 'https://fs.zapwize.com/files/22656920671/1n235001ri51d-of.pdf',
//                 caption: '📄 Test PDF from Baileys wrapper'
//             }
//         );

//         console.log('✅ All test messages sent.');
//     });
// });


