let autobahn = require('autobahn');
let winston = require('winston');

function WAMP(router, realm, tls) {
    let wamp_instance = Object.create(WAMP.prototype);
    wamp_instance.router = router;
    wamp_instance.realm = realm;
    wamp_instance.session = false;
    wamp_instance.connection = false;
    wamp_instance.closed = true; //used as sometimes autobahn calls onclose twice
    wamp_instance.force_close = false;
    wamp_instance.procedures = {};
    wamp_instance.subscriptions = {};
    wamp_instance.onopen = () => {};
    wamp_instance.onclose = () => {};
    wamp_instance.queue = undefined;
    wamp_instance.wamp = new autobahn.Connection({url: wamp_instance.router, realm: wamp_instance.realm, max_retries: 0, tlsConfiguration: tls || {}});
    wamp_instance.wamp.onopen = (session, details) => {
        winston.info("WAMP session established with " + wamp_instance.router);
        for (let procedure in wamp_instance.procedures) {
            if (wamp_instance.procedures.hasOwnProperty(procedure)) wamp_instance.run("register", wamp_instance.procedures[procedure]);
        }
        for (let subscription in wamp_instance.subscriptions) {
            if (wamp_instance.subscriptions.hasOwnProperty(subscription)) wamp_instance.run("subscribe", wamp_instance.subscriptions[subscription]);
        }
        wamp_instance.session = session;
        wamp_instance.resolve_connection(wamp_instance);
        wamp_instance.connection = false;
        wamp_instance.onopen(wamp_instance);
    };
    wamp_instance.wamp.onclose = (reason, details) => {
        if (wamp_instance.closed) return;
        wamp_instance.closed = true;
        if (wamp_instance.session) wamp_instance.onclose(wamp_instance);
        winston.warn("WAMP session closed with " + wamp_instance.router + ". Reason: " + reason);
        if (!wamp_instance.session || Object.keys(wamp_instance.procedures).length || Object.keys(wamp_instance.subscriptions).length) setTimeout(() => {
            if (!wamp_instance.force_close) {
                wamp_instance.closed = false;
                wamp_instance.wamp.open();
            }
            else {
                wamp_instance.force_close = false;
                wamp_instance.reject_connection(reason);
            }
        }, 5000);
        wamp_instance.session = undefined;
    };
    wamp_instance.resolve_connection = undefined;
    wamp_instance.reject_connection = undefined;
    return wamp_instance;
}

WAMP.prototype = {
    connect() {
        if (this.session && this.session.isOpen) return this;
        if (!this.connection) this.connection = new Promise((resolve, reject) => {
            if (this.connection) return resolve(this.connection);
            winston.verbose("WAMP session starting with " + this.router);
            this.resolve_connection = resolve;
            this.reject_connection = reject;
            this.closed = false;
            this.wamp.open();
        });
        return this.connection;
    },
    run(method, params, sync = false, timeout = 60000) {
        winston.debug("WAMP " + method + " with timeout " + timeout + "ms, sync=" + sync + " and params: ", params);
        let key, rejected = false;
        return new Promise((resolve, reject) => {
            this.queue = Promise.resolve(this.queue)
                .then(() => this.connect())
                .then(session => {
                    if (!method || !params) return resolve(session);
                    if (method === "unregister" || method === "unsubscribe") key = params.shift();
                    new Promise((resolve2, reject2) => {
                        let exec = () => {
                            if (this.session.hasOwnProperty(method)) return reject2("Non-recognized WAMP procedure: " + method);
                            let result = this.session[method](...params);
                            if (result && result.then) {
                                result.then(result => resolve2(result))
                                    .catch(err => {
                                        winston.error("WAMP error: ", err);
                                        if (err && err.error === "wamp.error.no_such_procedure" && !rejected) setTimeout(() => exec(), 5000);
                                        else reject2(err);
                                    });
                            }
                            else resolve2(result);
                        };
                        exec();
                    })
                    .then(result => {
                        if (sync) resolve(result);
                        winston.debug("Correctly run " + method + " with params: ", params);
                        if (method === "register") this.procedures[params[0]] = params;
                        if (method === "subscribe") this.subscriptions[params[0]] = params;
                        if (method === "unregister") delete this.procedures[key];
                        if (method === "unsubscribe") delete this.subscriptions[key];
                    })
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
                    rejected = true;
                    reject({timeout: true});
                }, timeout);
            }
        });
    },
    disconnect() {
        if (this.session && this.session.isOpen) this.wamp.close();
        this.force_close = true;
    },
    reset_connection() {
        this.connection = false;
    }
};

let instances = {};
module.exports = (router, realm, method, params, sync = false, timeout) => {
    let onopen, onclose, tls;
    if (router.hasOwnProperty('router') && router.hasOwnProperty('realm')) {
        onopen = router.onopen;
        onclose = router.onclose;
        sync = router.sync || false;
        params = router.params;
        method = router.method;
        realm = router.realm;
        timeout = router.timeout;
        tls = router.tls;
        router = router.router;
    }
    if (router && realm) {
        let key = router + ":" + realm;
        if (!instances.hasOwnProperty(key)) instances[key] = WAMP(router, realm, tls);
        if (typeof onopen === "function") instances[key].onopen = onopen;
        if (typeof onclose === "function") instances[key].onclose = onclose;
        if (method && params) return instances[key].run(method, params, sync, timeout);
        else return instances[key];
    }
    throw ("Missing mandatory fields");
};