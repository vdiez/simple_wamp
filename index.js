let autobahn = require('autobahn');
let winston = require('winston');

function WAMP(router, realm) {
    let wamp_instance = Object.create(WAMP.prototype);
    wamp_instance.router = router;
    wamp_instance.realm = realm;
    wamp_instance.session = false;
    wamp_instance.queue = undefined;
    return wamp_instance;
}

WAMP.prototype = {
    run(method, params, sync = false, timeout = 60000) {
        if (!method || !params) throw ("Missing mandatory fields");
        let self = this;
        return new Promise((resolve, reject) => {
            self.queue = Promise.resolve(self.queue)
                .then(() => {
                    if (self.session) return;
                    return new Promise((resolve2, reject2) => {
                        let wamp = new autobahn.Connection({url: self.router, realm: self.realm, max_retries: 0});
                        let connect = () => wamp.open();
                        wamp.onopen = session => {
                            winston.info("WAMP session established with " + self.router);
                            self.session = session;
                            resolve2();
                        };
                        wamp.onclose = (reason, details) => {
                            if (!self.session) {
                                winston.warn("WAMP session could not be established with " + self.router + ". Error: " + reason);
                                setTimeout(connect, 5000);
                            }
                            else winston.warn("WAMP session lost with " + self.router + ". Error: " + reason);
                            self.session = undefined;
                        };
                        connect();
                    });
                })
                .then(() => {
                    if (self.session.hasOwnProperty(method)) return reject("Non-recognized WAMP procedure: " + method);
                    let result = self.session[method](...params);
                    resolve(result);
                })
                .catch(err => winston.error("WAMP error: ", err));
            if (!sync) resolve();
            else {
                if (typeof timeout === "number") setTimeout(() => reject({timeout: true}), timeout);
            }
        });
    }
};

let instances = {};
module.exports = (router, realm, method, params, sync = false) => {
    if (router && realm) {
        let key = router + ":" + realm;
        if (!instances.hasOwnProperty(key)) instances[key] = WAMP(router, realm);
        if (method && params) return instances[key].run(method, params, sync);
        else return instances[key];
    }
    throw ("Missing mandatory fields");
};