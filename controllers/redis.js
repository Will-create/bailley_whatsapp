exports.install = function() {
    ROUTE('GET /');
    ROUTE('GET  /api/explorer/                *Explorer --> numbers');
    ROUTE('GET  /api/explorer/messages/                *Explorer --> messages');
    ROUTE('GET  /api/explorer/view/                *Explorer --> view');
}