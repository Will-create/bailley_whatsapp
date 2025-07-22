const Redis = require('redis');

if (!MAIN.redisinstances)
	MAIN.redisinstances = {};


ON('ready', function() {

	var client = Redis.createClient();
	// var client = Redis.createClient({ url: CONF.redis_server });

	MAIN.redisclient = client;

	MAIN.redisclient.on('error', function(err) {
		console.log(err);
		//SHELL('redis-server', NOOP);
	});

	MAIN.redisclient.on('connect', function() {
		console.log('CONNECTED TO REDIS SERVER!');
	});
	MAIN.redisclient.connect();
});

FUNC.loadMessage = async function(jid, msgid) {
	try {
		let pattern = `${jid}messages:${msgid}`;
		let raw = await MAIN.redisclient.get(pattern);
		if (!raw)
			return null;
		return JSON.parse(raw);
	} catch (err) {
		console.error('[FUNC.loadMessage] Error loading message:', err);
		return null;
	}
};

FUNC.loadMessages = async function(jid) {
	try {
		let pattern = `${jid}messages:*`;
		let keys = await MAIN.redisclient.keys(pattern);
		if (!keys || !keys.length)
			return [];

		let pipeline = MAIN.redisclient.multi();
		for (let key of keys)
			pipeline.get(key);

		let results = await pipeline.exec();
		return results
			.map(r => (r && r[1] ? JSON.parse(r[1]) : null))
			.filter(Boolean);

	} catch (err) {
		console.error('[FUNC.loadMessages] Error loading messages:', err);
		return [];
	}
};
