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
                    payload.clusterId = F.id;
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
                    payload.clusterId = F.id;
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
                    payload.clusterId = F.id;
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
                        await instance.refreshPairingCode();
                        $.callback({
                            success: true,
                            phone: phone,
                            clusterId: MAIN.sessionManager.clusterId
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

    schema.action('pairing_get', {
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
                    payload.clusterId = F.id;
                    payload.schema = 'Instance';
                    payload.action = 'pairing_get';
                    payload.params = $.params;
                    payload.query = $.query;

                    let res = await MAIN.clusterproxy.getresponse(payload);
                    $.callback(res);
                    return;
                }


                if (result.instance) {
                    // Local instance
                    try {
                        await instance.requestPairingCode();
                        $.callback({
                            success: true,
                            phone: phone,
                            clusterId: MAIN.sessionManager.clusterId
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
        input: '*phone:String,name:string,webhook:String',
        action: async function($, model) {
                let phone = model.phone;
                    try {
                        const instance = await MAIN.hub.getrandom().createInstanceWithPairingCode(phone, model);
                        instance && instance.on('pairing-code', function(data){
                            console.log('ON PAIRING CODE', data);
                            $.callback(data);
                        });
                        // let timeout = setTimeout(() => {
                        //     console.log(instance);
                        //     $.callback({
                        //         success: true,
                        //         phone: phone,
                        //         clusterId: MAIN.sessionManager.clusterId,
                        //         instanceId: instance.id,
                        //         pairingCode: instance.getCurrentPairingCode()
                        //     });
                        //     clearTimeout(timeout);
                        // }, 15000);
                        
                    } catch (error) {
                        $.callback({
                            success: false,
                            error: error.message,
                            clusterId: MAIN.sessionManager.clusterId
                        });
                    }
                
        }
    });
})