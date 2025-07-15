

let sessionManager;
// Configure cluster options
const clusterOptions = {
    cluster: 5, // or specific number like 4
    cluster_limit: 10, // maximum number of clusters
    // Session manager specific config
    maxInstances: 4000, // total across all clusters
    instancesPerWorker: 100,
    expectedClusters: 4, // helps calculate per-cluster limits
    healthCheckInterval: 30000,

    // WhatsApp specific config
    sessionPath: './sessions/',
    logLevel: 'info',

    // Cluster communication settings
    clusterTimeout: 5000,
    clusterRetries: 3
};
// Different initialization based on cluster mode
// Single instance mode (for development)
//

MAIN.clusterOptions = clusterOptions;

console.log(`Initializing cluster worker ${process.pid}`);
ON('ready', function () {

    // Create session manager instance for this cluster
    sessionManager = new MAIN.ClusterWhatsAppSessionManager(MAIN.clusterOptions);
    MAIN.sessionManager = sessionManager;
    // Setup global error handling
    sessionManager.on('instance-error', (data) => {
        console.error('Instance error:', data.error);
    });

    sessionManager.on('instance-created', (data) => {
        console.log(`Instance created: ${data.phone} in cluster ${sessionManager.clusterId}`);
    });

    sessionManager.on('instance-removed', (data) => {
        console.log(`Instance removed: ${data.phone} from cluster ${sessionManager.clusterId}, reason: ${data.reason}`);
    });

    // Setup graceful shutdown
    process.on('SIGTERM', async () => {
        console.log('Received SIGTERM, shutting down gracefully...');
        await sessionManager.gracefulShutdown();
        process.exit(0);
    });

    process.on('SIGINT', async () => {
        console.log('Received SIGINT, shutting down gracefully...');
        await sessionManager.gracefulShutdown();
        process.exit(0);
    });

    // Add cluster-specific routes
});