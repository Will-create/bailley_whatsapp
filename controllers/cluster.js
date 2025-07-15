exports.install = setupClusterRoutes;
function setupClusterRoutes() {
    // Create new instance with cluster awareness
    ROUTE('+POST /api/instances/', async function() {
        const { phone, config } = this.body;
        
        try {
            const instance = await MAIN.sessionManager.createInstance(phone, config);
            this.json({
                success: true,
                phone: phone,
                clusterId: MAIN.sessionManager.clusterId,
                instanceId: instance.id
            });
        } catch (error) {
            this.json({
                success: false,
                error: error.message,
                clusterId: MAIN.sessionManager.clusterId
            });
        }
    });
    
    // Create instance with pairing code
    ROUTE('+POST /api/instances/pairing/', async function() {
        const { phone, config } = this.body;

        try {
            const instance = await MAIN.sessionManager.createInstanceWithPairingCode(phone, config);
            this.json({
                success: true,
                phone: phone,
                clusterId: MAIN.sessionManager.clusterId,
                instanceId: instance.id,
                pairingCode: instance.getCurrentPairingCode()
            });
        } catch (error) {
            this.json({
                success: false,
                error: error.message,
                clusterId: MAIN.sessionManager.clusterId
            });
        }
    });
    
    // Delete instance
    ROUTE('+DELETE /api/instances/{phone}/', async function(phone) {
        try {
            await MAIN.sessionManager.removeInstance(phone, 'manual-delete');
            this.json({
                success: true,
                phone: phone,
                clusterId: MAIN.sessionManager.clusterId
            });
        } catch (error) {
            this.json({
                success: false,
                error: error.message,
                clusterId: MAIN.sessionManager.clusterId
            });
        }
    });
    
    // Get instance info (cluster-aware)
    ROUTE('+GET /api/instances/{phone}/', async function(phone) {
        try {
            const result = await MAIN.sessionManager.getInstanceGlobally(phone);
            if (!result) {
                this.throw404('Whatsapp Session not found');
                return;
            }
            
            if (result.instance) {
                // Local instance
                this.json({
                    phone: phone,
                    clusterId: result.clusterId,
                    local: true,
                    state: result.instance.state,
                    health: result.instance.getHealth()
                });
            } else {
                // Remote instance
                this.json({
                    phone: phone,
                    clusterId: result.clusterId,
                    local: false,
                    message: 'Instance exists on different cluster'
                });
            }
        } catch (error) {
            this.json({
                success: false,
                error: error.message,
                clusterId: MAIN.sessionManager.clusterId
            });
        }
    });
    
    // Refresh pairing code
    ROUTE('+POST /api/instances/{phone}/pairing/refresh/', async function(phone) {
        try {
            const newCode = await MAIN.sessionManager.refreshPairingCode(phone);
            this.json({
                success: true,
                phone: phone,
                pairingCode: newCode,
                clusterId: MAIN.sessionManager.clusterId
            });
        } catch (error) {
            this.json({
                success: false,
                error: error.message,
                clusterId: MAIN.sessionManager.clusterId
            });
        }
    });
    
    // Get pairing code
    ROUTE('+GET /api/instances/{phone}/pairing/', async function(phone) {
        try {
            const code = MAIN.sessionManager.getPairingCode(phone);
            this.json({
                success: true,
                phone: phone,
                pairingCode: code,
                clusterId: MAIN.sessionManager.clusterId
            });
        } catch (error) {
            this.json({
                success: false,
                error: error.message,
                clusterId: MAIN.sessionManager.clusterId
            });
        }
    });
    
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
}