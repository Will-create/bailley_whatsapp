
exports.install = function () {
    // Create instance with pairing code
    ROUTE('+POST /api/instances/pairing/ *Instance --> pairing');
    // Delete instance
    ROUTE('+DELETE /api/instances/{phone}/     *Instance --> delete');
        
    // Get instance info (cluster-aware)
    ROUTE('+GET /api/instances/{phone}/     *Instance --> read');
    
    // Refresh pairing code
    ROUTE('+POST /api/instances/{phone}/pairing/refresh/ *Instance --> pairing_refresh');
    
    // Get pairing code
    ROUTE('+GET /api/instances/{phone}/pairing/ *Instance --> pairing_get');
    

    ROUTE('+POST /api/config/{phone}/ *Manager --> config_save');
    ROUTE('+GET /api/config/{phone}/ *Manager --> config_read');
    ROUTE('+POST /api/rpc/{phone}/ *Manager --> rpc');
    ROUTE('+POST /api/send/{phone}/ *Manager --> send');
    ROUTE('+POST /api/media/{phone}/ *Manager --> media');

    // Global health check (all clusters)
    ROUTE('+GET /api/health/global/', async function() {
        const health = await MAIN.sessionManager.getGlobalHealthStatus();
        this.json(health);
    });
    
    // Local health check (current cluster)
    ROUTE('+GET /api/health/local/', function() {
        const health = MAIN.sessionManager.getLocalHealthStatus();
        this.json(health);
    });

        // Cluster management routes
        ROUTE('+GET /api/cluster/health/', async function() {
            const health = await MAIN.hub.getrandom().getGlobalHealthStatus();
            this.json(health);
        });

        ROUTE('+GET /api/cluster/instances/', function() {
            const instances = Array.from(MAIN.clusters.entries()).map(([phone, clusterId]) => ({
                phone,
                clusterId,
                local: false
            }));
            
            const localInstances = Array.values(MAIN.instances).map(instance => ({
                phone: instance.phone,
                clusterId: inst.clusterId,
                local: true,
                state: instance.state
            }));

            this.json({
                clusterId: inst.clusterId,
                localInstances,
                remoteInstances: instances,
                total: localInstances.length + instances.length
            });
        });
        ROUTE('+SOCKET /api/ws/{phone}/', async function (phone) {
            let result = await FUNC.findInstanceCluster(phone);
            const self = this;
            const socket = self;
            let instance;


            socket.send('Connected to ' + F.id);
            if (result)
                instance = result.instance;


            self.ws = true;
            self.autodestroy();
        
            socket.on('open', async function (client) {

                result = await FUNC.findInstanceCluster(phone);

        
                if (result && result.local) {
                    instance.ws_clients[client.id] = client;
                }

                if (MAIN.wsclients.has(phone)) {
                    let arr = MAIN.wsclients.get(phone);
                    arr.push(client);
                    MAIN.wsclients.set(phone, arr);
                } else {
                    MAIN.wsclients.set(phone, [client]);
                }
        
                MAIN.clusterproxy && MAIN.clusterproxy.setconnection(phone, result.clusterId);
        
                setTimeout(() => {
                    if (result && result.local && instance.state === 'open') {
                        client.send({ type: 'ready', clusterId: F.id });
                    }
                }, 2000);
            });
        
            socket.on('message', async function (client, msg) {
                result = await FUNC.findInstanceCluster(phone);
                console.log('MESSAGE : ', msg, result.clusterId, F.id);

                if (result && result.instance)
                    instance = result.instance;

                
                if (result && !result.local) {
                    try {
                        const response = await MAIN.clusterproxy.sendWithAck('proxy-ws-message', {
                            clusterId: result.clusterId,          // who is sending the proxy call
                            phone,                    // target phone
                            msg                       // original socket message
                        }, {
                            timeout: 5000,            // max wait before timeout
                            retries: 1                // one retry if ACK fails
                        });
            
                        const data = await MAIN.clusterproxy.unwrap(response);
                        return client.send(data.output || { success: true });
            
                    } catch (err) {
                        console.warn(`[WS REMOTE] Proxy send failed for ${phone}:`, err.message);
                        return client.send({ success: false, value: 'Cluster WS proxy timeout or error' });
                    }
                }
        
                if (msg?.topic) {
                    self.client = client;
                    instance && instance.message(msg, self);
                }
        
                if (msg?.type) {
                    switch (msg.type) {
                        case 'text':
                            if (instance && instance.state === 'open') instance.send_message(msg);
                            break;
                        case 'file':
                            if (instance && instance.state === 'open') instance.send_file(msg);
                            break;
                    }
        
                    client.send({
                        success: (instance && instance.state === 'open') || false,
                        state: instance ? instance.state : 'UNKNOWN',
                        clusterId: F.id
                    });
                }
            });
        
            socket.on('disconnect', function (client) {
                console.log('Client disconnected:', client.id, 'cluster:', F.id);
                if (result.local && instance.ws_clients[client.id]) {
                    delete instance.ws_clients[client.id];
                }
            });
        });
        

}