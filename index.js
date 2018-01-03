let autobahn = require('autobahn');
let winston = require('winston');

function WAMP(router, realm) {
    let wamp_instance = Object.create(WAMP.prototype);
    wamp_instance.router = router;
    wamp_instance.realm = realm;
    wamp_instance.session = false;
    wamp_instance.queue = undefined;
    wamp_instance.connecting = false;
    return wamp_instance;
}

WAMP.prototype = {
    run(method, params, sync = false, timeout = 60000) {
        if (!method || !params) throw ("Missing mandatory fields");
        return new Promise((resolve, reject) => {
            this.queue = Promise.resolve(this.queue)
                .then(() => {
                    if (this.session && this.session.isOpen) return;
                    return new Promise((resolve2, reject2) => {
                        let wamp = new autobahn.Connection({url: this.router, realm: this.realm, max_retries: 0});
                        let connect = () => {
                            if (this.connecting) return;
                            winston.verbose("WAMP session starting with " + this.router);
                            this.connecting = true;
                            wamp.open();
                        };
                        wamp.onopen = session => {
                            winston.info("WAMP session established with " + this.router);
                            this.session = session;
                            resolve2();
                        };
                        wamp.onclose = (reason, details) => {
                            this.connecting = false;
                            if (!this.session) {
                                winston.warn("WAMP session could not be established with " + this.router + ". Error: " + reason, details);
                                setTimeout(connect, 5000);
                            }
                            else winston.warn("WAMP session lost with " + this.router + ". Error: " + reason);
                            this.session = undefined;
                        };
                        connect();
                    });
                })
                .then(() => {
                    if (this.session.hasOwnProperty(method)) return reject("Non-recognized WAMP procedure: " + method);
                    let result = this.session[method](...params);
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