require('querybuilderpg').init('', CONF.database, 1, ERROR('DB'));
require('querybuilderpg').init('db2', CONF.database2, 1, ERROR('DB2'));


const { MongoClient } = require('mongodb');
const logger = require('pino')()
MAIN.logger = logger;
MAIN.connectToCluster = async function (uri) {
    let mongoClient

    try {
        mongoClient = new MongoClient(uri, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        })
        logger.info('STATE: Connecting to MongoDB')
        await mongoClient.connect()
        logger.info('STATE: Successfully connected to MongoDB')
        return mongoClient
    } catch (error) {
        logger.error('STATE: Connection to MongoDB failed!', error)
        process.exit()
    }
}



ON('ready', async function() {
    global.mongoClient = await MAIN.connectToCluster(CONF.mongosh_uri);
    EMIT('mongo:ready');
    //FUNC.refresh_config();
})