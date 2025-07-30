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

    schema.action('pause', {
        name: 'Pause the instance',
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
                    payload.action = 'pause';
                    payload.params = $.params;
                    payload.query = $.query;
                    let res = await MAIN.clusterproxy.getresponse(payload);
                    $.callback(res);
                    return;
                }
                if (result.instance) {
                    // Local instance
                    try {
                    
                        await local.instance.pauseInstance();
                        $.callback({ success: true, phone, value: true });
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


    schema.action('resume', {
        name: 'Resume the instance',
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
                    payload.action = 'resume';
                    payload.params = $.params;
                    payload.query = $.query;
                    let res = await MAIN.clusterproxy.getresponse(payload);
                    $.callback(res);
                    return;
                }
                if (result.instance) {
                    // Local instance
                    try {
                    
                        await local.instance.resumeInstance();
                        $.callback({ success: true, phone, value: true });
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


    schema.action('logout', {
        name: 'Logout the instance',
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
                    payload.action = 'resume';
                    payload.params = $.params;
                    payload.query = $.query;
                    let res = await MAIN.clusterproxy.getresponse(payload);
                    $.callback(res);
                    return;
                }
                if (result.instance) {
                    // Local instance
                    try {
                        await local.instance.logoutInstance();
                        $.callback({ success: true, phone, value: true });
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


    schema.action('status', {
        name: 'Get the status of the instance',
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
                    payload.action = 'status';
                    payload.params = $.params;
                    payload.query = $.query;
                    let res = await MAIN.clusterproxy.getresponse(payload);
                    $.callback(res);
                    return;
                }
                if (result.instance) {
                    // Local instance
                    try {
                        let status = await local.instance.status();
                        $.callback({ success: true, phone, value: status });
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
    schema.action('exists', {
        name: 'Check if a whatsapp session exists',
		params: '*phone:String',
        action: async function($) {
                let phone = $.params.phone;
                const result = await FUNC.findInstanceCluster(phone);
                if (!result)
                    $.callback({ success: false, phone, value: false });
                else
                    $.callback({ success: true, phone, value: true });
        }
    });

    schema.action('dashboard', {
        name: 'Get dashboard data for an instance',
        params: '*phone:String',
        action: async function($) {
            let phone = $.params.phone;
            let db = DB();

            async function getDashboardData(number) {
                let numberid = number.id;
                let plan = await db.read('tbl_plan').id(number.plans.split(',')[0]).promise();

                let today = new Date();
                let yesterday = new Date();
                yesterday.setDate(yesterday.getDate() - 1);

                let today_reqs = await db.find('tbl_request').where('numberid', numberid).where('date', today.format('dd-MM-yyyy')).promise();
                let yesterday_reqs = await db.find('tbl_request').where('numberid', numberid).where('date', yesterday.format('dd-MM-yyyy')).promise();

                let totalRequests = await db.count('tbl_request').where('numberid', numberid).promise();

                let increase = 0;
                if (yesterday_reqs.length > 0) {
                    increase = ((today_reqs.length - yesterday_reqs.length) / yesterday_reqs.length) * 100;
                }

                let planUsage = (totalRequests.count / plan.maxlimit) * 100;

                let chartData = {
                    labels: [],
                    data: []
                };

                for (let i = 6; i >= 0; i--) {
                    let date = new Date();
                    date.setDate(date.getDate() - i);
                    let date_string = date.format('dd-MM-yyyy');
                    let reqs = await db.find('tbl_request').where('numberid', numberid).where('date', date_string).promise();
                    chartData.labels.push(date.format('MMM dd'));
                    chartData.data.push(reqs.length);
                }

                return {
                    totalRequests: totalRequests.count,
                    increase: increase.toFixed(2),
                    planUsage: planUsage.toFixed(2),
                    planLimit: plan.maxlimit,
                    chartData: chartData
                };
            }

            if (phone === 'all') {
                let numbers = await db.find('tbl_number').promise();
                let allData = {
                    totalRequests: 0,
                    increase: 0,
                    planUsage: 0,
                    planLimit: 0,
                    chartData: {
                        labels: [],
                        data: []
                    }
                };

                let chartMap = new Map();

                for (let number of numbers) {
                    let data = await getDashboardData(number);
                    allData.totalRequests += data.totalRequests;
                    allData.planLimit += data.planLimit;

                    for (let i = 0; i < data.chartData.labels.length; i++) {
                        let label = data.chartData.labels[i];
                        let value = data.chartData.data[i];
                        if (chartMap.has(label)) {
                            chartMap.set(label, chartMap.get(label) + value);
                        } else {
                            chartMap.set(label, value);
                        }
                    }
                }

                allData.planUsage = (allData.totalRequests / allData.planLimit) * 100;

                let today = new Date();
                let yesterday = new Date();
                yesterday.setDate(yesterday.getDate() - 1);

                let today_reqs_total = 0;
                let yesterday_reqs_total = 0;

                for (let number of numbers) {
                    let today_reqs = await db.find('tbl_request').where('numberid', number.id).where('date', today.format('dd-MM-yyyy')).promise();
                    let yesterday_reqs = await db.find('tbl_request').where('numberid', number.id).where('date', yesterday.format('dd-MM-yyyy')).promise();
                    today_reqs_total += today_reqs.length;
                    yesterday_reqs_total += yesterday_reqs.length;
                }

                if (yesterday_reqs_total > 0) {
                    allData.increase = ((today_reqs_total - yesterday_reqs_total) / yesterday_reqs_total) * 100;
                }

                allData.chartData.labels = Array.from(chartMap.keys());
                allData.chartData.data = Array.from(chartMap.values());

                $.callback(allData);

            } else {
                const result = await FUNC.findInstanceCluster(phone);
                if (!result) {
                    $.invalid('Whatsapp session not found');
                    return;
                }

                let number = await db.read('tbl_number').where('phonenumber', phone).promise();
                let data = await getDashboardData(number);
                $.callback(data);
            }
        }
    });
})
