exports.install = function() {
    ROUTE('FILE /download/*.*', download);
}

function download(req, res) {
	var second = req.split[1];
    let db;
    let id;
    db = second.split('_')[0];

    let str = second.split('_')[1];
	var index = str.lastIndexOf('.');
	if (index !== -1) {
		var hash = str.substring(0, index);
		id = hash.substring(0, hash.indexOf('-', 10));
		if (hash === id.sign(CONF.salt)) {
			res.filefs(db, id);
			return;
		}
	}

	res.throw404();
}