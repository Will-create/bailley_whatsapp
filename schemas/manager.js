NEWSCHEMA('Manager', function(schema) {
    schema.action('config_save', {
        name: 'Update or save Config data',
        params: '*phone:String',
        action: async function($, model) {
            let phone = $.params.phone;
            const result = await FUNC.findInstanceCluster(phone);
            
            if (!result) {
                $.invalid('Whatsapp session not found');
                return;
            }

            if (!result.local) {
                $.clusterId = result.clusterId;
                let res = await MAIN.clusterproxy.callSchemaRemote($, model, 'Manager', 'config_save');
                $.callback(res);
                return;
            }

            result.instance.memory_refresh(model, function () {
                $.success();
            });
        }
    });

    schema.action('config_read', {
        name: 'Read informations about a given config',
        params: '*phone:String',
        action: async function($) {
            let phone = $.params.phone;
            const result = await FUNC.findInstanceCluster(phone);
            
            if (!result) {
                $.invalid('Whatsapp session not found');
                return;
            }
    
            if (!result.local) {
                $.clusterId = result.clusterId;
                let res = await MAIN.clusterproxy.callSchemaRemote($, null, 'Manager', 'config_read');
                $.callback(res);
                return;
            }

            $.callback(result.instance.Data);
        }
    });


    schema.action('rpc', {
        name: 'Remote PC Controller',
        params: '*phone:String',
        input: 'topic:String,type:String,content:String,data:Object',
        action: async function($, model) {
            let phone = $.params.phone;
            const result = await FUNC.findInstanceCluster(phone);
            if (!result) {
                $.invalid('Whatsapp session not found');
                return;
            }
            if (!result.local) {
                $.clusterId = result.clusterId;
                let res = await MAIN.clusterproxy.callSchemaRemote($, null, 'Manager', 'rpc');
                $.callback(res);
                return;
            }
            $.ws = false;
            let res = result.instance.message(model);
            $.callback(res);
        }
    });
    schema.action('send', {
        name: 'Send text message to a whatsapp user',
        params: '*phone:String',
        input: '*chatid:String,content:String',
        action: async function($, model) {
            let phone =  $.params.phone;
            const result = await FUNC.findInstanceCluster(phone);
            
            if (!result) {
                $.invalid('Whatsapp instance not found');
                return;
            }
    
            if (!result.local) {
                $.clusterId = result.clusterId;
                let res = await MAIN.clusterproxy.callSchemaRemote($, model, 'Manager', 'send');
                $.callback(res);
                return;
            }
    
            const instance = result.instance;
            if (instance.state == 'open') {
                instance.sendMessage(model);
                instance.usage($);
            }
    
            if (instance.state == 'open')
                $.success();
            else
                $.callback({ success: false, state: instance.state });

        }
    });

    schema.action('media', {
        name: 'Send Media to a whatsapp number',
        input: '*chatid:Phone,type:String,topic:String,content:Object',
        params: '*phone:String',
        action: async function($, model) {
            let phone = $.params.phone;
            const result = await FUNC.findInstanceCluster(phone);
            
            if (!result) {
                $.invalid('Whatsappp session not Found');
                return;
            }
    
            if (!result.local) {
                $.clusterId = result.clusterId;
                let res = await MAIN.clusterproxy.callSchemaRemote($, model, 'Manager', 'media');
                $.callback(res);
                return;
            }
    
            const instance = result.instance;
            if (instance.state == 'open') {
                instance.send_file($.body);
                instance.usage($);
            }
    
            if (instance.state == 'open')
                $.success();
            else
                $.callback({ success: false, state: instance.state });
            
        }
    });
});
