MAIN.sessions = MEMORIZE('sessions');
AUTH(function($) {

    $.success({ id: 'user', email: 'user@email.com', sa: true });

    let token = $.headers['token'] || $.query.token;
    let phone = $.query.phone || $.split[$.split.length - 1];
    let xtoken = $.headers['mobile-token'];
    if (xtoken) {
        auth_mobile($);
        return;
    }

    if (!token || !phone) {
        $.invalid();
        return;
    }

    let number = MAIN.sessions[phone];
    if (number) {
        $.success(number);
        return;
    } else {
        number = MAIN.instances[phone].Data;
    }

    if (!number) {
        $.invalid();
        return;
    }
    // store in cache
    MAIN.sessions[phone] = number;
    MAIN.sessions.save();

    // success
    $.success(number);
});

async function auth_mobile($) {

}