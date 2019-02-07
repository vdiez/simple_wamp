let autobahn = require('autobahn');
let winston = require('winston');

function WAMP(params) {
    let wamp_instance = Object.create(WAMP.prototype);
    wamp_instance.config = params;
    wamp_instance.session = false;
    wamp_instance.connection = false;
    wamp_instance.closed = true; //used as sometimes autobahn calls onclose twice
    wamp_instance.force_close = false;
    wamp_instance.procedures = {};
    wamp_instance.subscriptions = {};
    wamp_instance.onopen = typeof params.onopen === "function" ? params.onopen : () => {};
    wamp_instance.onclose = typeof params.onclose === "function" ? params.onclose : () => {};
    wamp_instance.queue = undefined;
    wamp_instance.wamp = new autobahn.Connection({
        url: params.url,
        realm: params.realm,
        max_retries: 0,
        tlsConfiguration: params.tls || {},
        authmethods: params.authmethods || [],
        onchallenge: params.hasOwnProperty('onchallenge') ? (typeof params.onchallenge === 'function' ? params.onchallenge : () => params.onchallenge) : undefined,
        authid: params.authid,
        authextra: params.authextra
    });
    wamp_instance.wamp.onopen = (session, details) => {
        winston.info("WAMP session established with " + params.url);
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
        winston.warn("WAMP session closed with " + params.url + ". Reason: " + reason, details);
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
            winston.verbose("WAMP session starting with " + this.config.url);
            this.resolve_connection = resolve;
            this.reject_connection = reject;
            this.closed = false;
            this.wamp.open();
        });
        return this.connection;
    },
    run(method, params, sync = false, timeout = 60000) {
        let rejected = false;
        return new Promise((resolve, reject) => {
            this.queue = Promise.resolve(this.queue)
                .then(() => this.connect())
                .then(session => {
                    if (!method || !params) return resolve(session);
                    new Promise((resolve2, reject2) => {
                        let exec = () => {
                            if (this.session.hasOwnProperty(method)) return reject2("Non-recognized WAMP procedure: " + method);
                            let result = this.session[method](...params);
                            if (result && result.then) {
                                result.then(result => resolve2(result))
                                    .catch(err => {
                                        if (err && err.error === "wamp.error.no_such_procedure" && !rejected) setTimeout(() => exec(), 5000);
                                        else return reject2(err);
                                        winston.error("WAMP error on " + method + " with params: ", params, "Error: ", err);
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
                            if (method === "unregister") delete this.procedures[params[0].topic];
                            if (method === "unsubscribe") delete this.subscriptions[params[0].topic];
                        })
                        .catch(err => {
                            winston.error("WAMP error on " + method + " with params: ", params, "Error: ", err);
                            reject(err);
                        });
                })
                .catch(err => {
                    winston.error("WAMP error on " + method + " with params: ", params, "Error: ", err);
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
    register(procedure, endpoint, options) {
        return this.run("register", [procedure, endpoint, options], options.sync, options.timeout)
    },
    unregister(registration, options) {
        return this.run("unregister", [registration, options], options.sync, options.timeout)
    },
    call(procedure, args, kwargs, options) {
        return this.run("call", [procedure, args, kwargs, options], options.sync, options.timeout)
    },
    subscribe(topic, handler, options) {
        return this.run("subscribe", [topic, handler, options], options.sync, options.timeout)
    },
    unsubscribe(subscription, options) {
        return this.run("unsubscribe", [subscription, options], options.sync, options.timeout)
    },
    publish(topic, args, kwargs, options) {
        return this.run("publish", [topic, args, kwargs, options], options.sync, options.timeout)
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
let most_recent;
module.exports = ({router, method, params, sync = false, timeout} = {}) => {
    if (!router && most_recent) router = most_recent;
    else if (router.save) most_recent = router;

    if (!router || !router.hasOwnProperty('url') || !router.hasOwnProperty('realm')) throw ("Missing mandatory fields");

    let key = router.url + ":" + router.realm;

    if (!instances.hasOwnProperty(key)) instances[key] = WAMP(router);
    if (method && params) return instances[key].run(method, params, sync, timeout);
    else return instances[key];
};