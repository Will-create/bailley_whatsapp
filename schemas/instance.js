NEWSCHEMA('Instance', function(schema) {
    schema.action('read', {
        name: 'Create instance',
        params: '*phone:String',
        action: async function($) {
                let phone = $.params.phone;


                const result = await FUNC.findInstanceCluster(phone);

                if (!result) {
                    $.invalid('Whatsapp session not found');
                    return;
                }

                if (!result.local) {
                    let payload = {};
                    payload.clusterId = result.clusterId;
                    payload.schema = 'Instance';
                    payload.action = 'read';
                    payload.params = $.params;
                    payload.query = $.query;

                    let res = await MAIN.clusterproxy.getresponse(payload);
                    $.callback(res);
                    return;
                }

                // Local instance
                $.callback({
                    phone: phone,
                    clusterId: result.clusterId,
                    local: true,
                    state: result.instance.state,
                    health: result.instance.getHealth(),
                    logs: result.instance.logs,
                    config: result.instance.config || result.instance.data
                });

        }
    });


    schema.action('delete', {
        name: 'Create instance',
        params: '*phone:String',
        action: async function($) {
                let phone = $.params.phone;
                const result = await FUNC.findInstanceCluster(phone);

                if (!result) {
                    $.invalid('Whatsapp session not found');
                    return;
                }

                if (!result.local) {
                    let payload = {};
                    payload.clusterId = result.clusterId;
                    payload.schema = 'Instance';
                    payload.action = 'read';
                    payload.params = $.params;
                    payload.query = $.query;
                    let res = await MAIN.clusterproxy.getresponse(payload);
                    $.callback(res);
                    return;
                }

                await MAIN.sessionManager.removeInstance(phone, 'manual-delete');
                $.callback({
                    success: true,
                    phone: phone,
                    clusterId: MAIN.sessionManager.clusterId
                });
        }
    });

    schema.action('pairing_refresh', {
        name: 'Refresh the pairing code',
        params: '*phone:String',
        action: async function($) {
                let phone = $.params.phone;


                const result = await FUNC.findInstanceCluster(phone);

                if (!result) {
                    $.invalid('Whatsapp session not found');
                    return;
                }

                if (!result.local) {
                    let payload = {};
                    payload.clusterId = result.clusterId;
                    payload.schema = 'Instance';
                    payload.action = 'pairing_refresh';
                    payload.params = $.params;
                    payload.query = $.query;

                    let res = await MAIN.clusterproxy.getresponse(payload);
                    $.callback(res);
                    return;
                }

                if (result.instance) {
                    // Local instance
                    try {
                        await result.instance.refreshPairingCode();
						result.instance.on('pairing-code', function(data) {
							$.callback({ success: true, phone, value: data.code });
						});
                    } catch (error) {
                        $.callback({
                            success: false,
                            error: error.message,
                            clusterId: MAIN.sessionManager.clusterId
                        });
                    }
                }

        }
    });


    schema.action('pairing', {
        name: 'Refresh the pairing code',
        input: '*phone:String,name:string,webhook:String,token:String,baseurl:String,usePairingCode:Boolean',
        action: async function($, model) {
                let phone = model.phone;
                    try {
                        const instance = await MAIN.hub.getrandom();
						instance && instance.createInstanceWithPairingCode(phone, model);
                        instance && instance.on('pairing-code', function(data){
                            $.callback({ success: true, phone, value: data.code });
                        });

                    } catch (error) {
                        $.callback({
                            success: false,
                            error: error.message,
                            clusterId: MAIN.sessionManager.clusterId
                        });
                    }

        }
    });

    schema.action('qr', {
        name: 'Create instance with qrcode scanning',
        input: '*phone:String,name:string,webhook:String,token:String,baseurl:String,usePairingCode:Boolean',
        action: async function($, model) {
                let phone = model.phone;
                    try {
                        const instance = await MAIN.hub.getrandom();
						instance && instance.createInstanceWithQRCode(phone, model);
                        instance && instance.on('qr', function(data){
                            $.callback({ success: true, phone, value: data });
                        });

                    } catch (error) {
                        $.callback({
                            success: false,
                            error: error.message,
                            clusterId: MAIN.sessionManager.clusterId
                        });
                    }
        }
    });

    schema.action('qr_get', {
        name: 'Get qr code of existing instance',
		params: '*phone:String',
        action: async function($) {
                let phone = $.params.phone;
                const result = await FUNC.findInstanceCluster(phone);
                if (!result) {
                    $.invalid('Whatsapp session not found');
                    return;
                }
                if (!result.local) {
                    let payload = {};
                    payload.clusterId = result.clusterId;
                    payload.schema = 'Instance';
                    payload.action = 'qr_get';
                    payload.params = $.params;
                    payload.query = $.query;
                    let res = await MAIN.clusterproxy.getresponse(payload);
                    $.callback(res);
                    return;
                }
                if (result.instance) {
                    // Local instance
                    try {
                        let qr = instance.qrcode;
                        $.callback({ value: qr });
                    } catch (error) {
                        $.callback({
                            success: false,
                            error: error.message,
                            clusterId: MAIN.sessionManager.clusterId
                        });
                    }
                }
        }
    });
})