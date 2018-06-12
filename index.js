let autobahn = require('autobahn');
let winston = require('winston');

function WAMP(router, realm) {
    let wamp_instance = Object.create(WAMP.prototype);
    wamp_instance.router = router;
    wamp_instance.realm = realm;
    wamp_instance.session = false;
    wamp_instance.connecting = false;
    wamp_instance.closed = true;
    wamp_instance.procedures = {};
    wamp_instance.subscriptions = {};
    wamp_instance.onopen = [];
    wamp_instance.onclose = [];
    wamp_instance.queue = undefined;
    return wamp_instance;
}

WAMP.prototype = {
    run(method, params, sync = false, timeout = 60000) {
        if (!method || !params) throw ("Missing mandatory fields");
        let failed = false;
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
                            this.closed = false;
                            wamp.open();
                        };
                        wamp.onopen = (session, details) => {
                            winston.info("WAMP session established with " + this.router);
                            for (let procedure in this.procedures) {
                                if (this.procedures.hasOwnProperty(procedure)) this.run("register", this.procedures[procedure]);
                            }

                            for (let subscription in this.subscriptions) {
                                if (this.subscriptions.hasOwnProperty(subscription)) this.run("subscribe", this.subscriptions[subscription]);
                            }

                            this.onopen.forEach(f => f(session, details));
                            this.session = session;
                            resolve2();
                        };
                        wamp.onclose = (reason, details) => {
                            if (this.closed) return;
                            if (this.session) this.onclose.forEach(f => f(reason, details));
                            this.closed = true;
                            this.connecting = false;
                            winston.warn("WAMP session could not be established with " + this.router + ". Error: " + reason);
                            if (!this.session || Object.keys(this.procedures).length || Object.keys(this.subscriptions).length) setTimeout(connect, 5000);
                            this.session = undefined;
                        };
                        connect();
                    });
                })
                .then(() => {
                    new Promise((resolve2, reject2) => {
                        let exec = () => {
                            if (this.session.hasOwnProperty(method)) return reject2("Non-recognized WAMP procedure: " + method);
                            if (method === "register") this.procedures[params[0]] = params;
                            if (method === "subscribe") this.subscriptions[params[0]] = params;
                            let result = this.session[method](...params);
                            if (result && result.then) {
                                result.then(result => resolve2(result))
                                    .catch(err => {
                                        winston.error("WAMP error: ", err);
                                        if (err && err.error === "wamp.error.no_such_procedure" && !failed) setTimeout(() => exec(), 5000)
                                        else reject2(err);
                                    });
                            }
                            else resolve2(result);
                        };
                        exec();
                    })
                    .then(result => sync && resolve(result))
                    .catch(err => {
                        winston.error("WAMP error: ", err);
                        reject(err);
                    });
                })
                .catch(err => {
                    winston.error("WAMP error: ", err);
                    reject(err);
                });
            if (!sync) resolve();
            else {
                if (typeof timeout === "number") setTimeout(() => {
                    failed = true;
                    reject({timeout: true});
                }, timeout);
            }
        });
    }
};

let instances = {};
module.exports = (router, realm, method, params, sync = false) => {
    if (router.hasOwnProperty('router') && router.hasOwnProperty('realm')) {
        sync = params;
        params = method;
        method = realm;
        router = router.router;
        realm = router.realm;
    }
    if (router && realm) {
        let key = router + ":" + realm;
        if (!instances.hasOwnProperty(key)) instances[key] = WAMP(router, realm);
        if (router.onopen) instances[key].onopen.push(router.onopen);
        if (router.onclose) instances[key].onclose.push(router.onclose);
        if (method && params) return instances[key].run(method, params, sync);
        else return instances[key];
    }
    throw ("Missing mandatory fields");
};