
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