NEWSCHEMA('Explorer', function(schema) {

    // Lists unique numbers from Redis keys
    schema.action('numbers', {
        name: 'List all phone numbers',
        action: async function($) {
            const keys = await MAIN.redisclient.keys('*messages:*');
            const numbers = new Set();

            for (let key of keys) {
                const idx = key.indexOf('messages:');
                if (idx !== -1)
                    numbers.add(key.substring(0, idx));
            }

            $.callback([...numbers]);
        }
    });

    // Lists all message keys for a selected number
    schema.action('messages', {
        name: 'List messages for selected number',
        query: '*number:String',
        action: async function($) {
            const keys = await MAIN.redisclient.keys(`${$.query.number}messages:*`);
            const formatted = keys.map(key => {
                const parts = key.split(':');
                return {
                    key,
                    jid: parts[1],
                    msgid: parts[2] || null
                };
            });
            $.callback(formatted);
        }
    });

    // Get the full Redis message content
    schema.action('view', {
        name: 'View message by full Redis key',
        query: '*key:String',
        action: async function($) {
            const data = await MAIN.redisclient.get($.query.key);
            $.callback(data ? JSON.parse(data) : null);
        }
    });

});
