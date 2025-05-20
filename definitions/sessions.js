

function Session() {

}

let SP = Session.prototype;

SP.restore = async function () {
    let sessions = [];
    let collections = [];
    try {

        let db = mongoClient.db('zapwize');
        let arr = await db.listCollections().toArray();
        arr && arr.wait(function (col, next) {
            collections.push(col.name);
            next();
        }, function () {
            collections && collections.wait(async function (collection, resume) {
                let query = {};
                db.collection(collection).find(query).toArray(async function (err, result) {
                    if (err)
                        throw err;

                    let instance = new MAIN.Instance(collection);
                    instance.init();
                });
                resume();
            }, function () {
                MAIN.instances = sessions;
            })
        });
    } catch (e) {
        MAIN.logger && MAIN.logger.error('Error restoring sessions...');
        MAIN.logger && MAIN.logger.error(e);
    }
}

ON('mongo:ready', function() {
    let session = new Session();
    session.restore();
});