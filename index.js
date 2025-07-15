
let sock = require('path').join(require('os').tmpdir(), 'baileys134');
console.log(sock);
// Configure cluster options
const clusterOptions = {
    cluster: 5, // or specific number like 4
    cluster_limit: 10, // maximum number of clusters
    unixsocket: sock,
    unixsocket777 : true,
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
require('total4/release')(clusterOptions);

