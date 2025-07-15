
exports.install = function() {
	ROUTE('#401', function()             {
        let $ = this;
		respond($, 401,                   'Unauthorized request');
	});

	ROUTE('#404', function()             {
        let $ = this;
		respond($, 404,                   'Ressource not found');
	});

	ROUTE('#400', function()             {
        let $ = this;
		respond($, 400,                   'Bad Request');
	});
}


function respond(self, code, message) {
	self.json({success: false, code: code, value: message, processid: process.pid, clusterid: F.id });
}