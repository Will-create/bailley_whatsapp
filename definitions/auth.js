MAIN.sessions = MEMORIZE('sessions');
AUTH(async function($) {

    let token = $.headers['token'] || $.query.token;
    let phone = $.query.phone || $.split[$.split.length - 1];
    let xtoken = $.headers['mobile-token'];

    let isinternal = ($.split[0] + '/' + $.split[1]) == 'api/instances';

    if (isinternal) {
        await auth_api($);
        return;
    }

    if (xtoken) {
        await auth_mobile($);
        return;
    }

    if (!token || !phone) {
        $.invalid();
        return;
    }

    let number;
    // Try to get from cache first
    if (MAIN.sessions[phone]) {
        number = MAIN.sessions[phone];
    } else if (MAIN.instances.has(phone)) {
        number = MAIN.instances.get(phone).Data;
    }

    if (!number) {
        // If not found in cache or active instances, try database
        try {
            number = await F.db.read('db2/tbl_number').where('phonenumber', phone).promise();
            if (number && number.token !== token) {
                $.invalid('Invalid token');
                return;
            }
        } catch (e) {
            console.error('Error reading number from DB:', e);
            $.invalid('Authentication failed');
            return;
        }
    }

    if (!number) {
        $.invalid();
        return;
    }

    // Store in cache if not already there
    if (!MAIN.sessions[phone]) {
        MAIN.sessions[phone] = number;
        MAIN.sessions.save();
    }

    // Check plan limits and update usage for non-mobile auth
    let instance = MAIN.instances.get(phone);
    if (instance) {
        await instance.usage($, instance);
        if (instance.is_maxlimit || instance.is_limit) {
            $.invalid('Usage limit exceeded');
            return;
        }
    }

    $.success(number);
});

async function auth_mobile($) {
    let xtoken = $.headers['mobile-token'];
    if (!xtoken) {
        $.invalid('Invalid mobile token');
        return;
    }

    try {
        let number = await F.db.read('db2/tbl_number').where('token', xtoken).promise();

        if (!number) {
            $.invalid('Invalid mobile token');
            return;
        }

        let instance = MAIN.instances.get(number.phonenumber);

        if (!instance) {
            $.invalid('WhatsApp instance not found for this number.');
            return;
        }

        // Check plan limits and update usage
        await instance.usage($, instance); // Assuming instance.usage handles the request counting and limit checks

        $.success({
            id: number.id,
            phonenumber: number.phonenumber,
            token: number.token,
            userid: number.userid,
            planid: instance.plan ? instance.plan.id : 'N/A',
            is_maxlimit: instance.is_maxlimit,
            is_limit: instance.is_limit
        });

    } catch (e) {
        console.error('Error during mobile authentication:', e);
        $.invalid('Authentication failed: ' + e.message);
    }
}

async function auth_api($) {
    let xtoken = $.headers['itoken'];

    if (!xtoken) {
        $.invalid();
        return;
    }

    if (xtoken != CONF.token) {
        $.invalid();
        return;
    }


    $.success({ id: 'bot', name: 'Admin bot', sa: true });
}