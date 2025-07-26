var sock = '/www/www/zapwize_com-server0/superadmin.socket';
// Configure cluster options
const clusterOptions = {
    cluster: 5, // or specific number like 4
    cluster_limit: 10, // maximum number of clusters
    unixsocket: sock,
    unixsocket777 : true,
    maxInstances: 4000, // total across all clusters
    instancesPerWorker: 100,
    expectedClusters: 4, // helps calculate per-cluster limits
    healthCheckInterval: 30000,
    sessionPath: './sessions/',
    logLevel: 'info',
    clusterTimeout: 5000,
    clusterRetries: 3
};
// Different initialization based on cluster mode
        // Single instance mode (for development)
require('total4/release')(clusterOptions);

