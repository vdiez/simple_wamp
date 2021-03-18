let autobahn = require('autobahn');
let log = {error() {}, warn() {}, info() {}, verbose() {}, debug() {}, silly() {}};

function WAMP(params) {
    let wamp_instance = Object.create(WAMP.prototype);
    wamp_instance.config = params;
    wamp_instance.session = false;
    wamp_instance.pending_connection = false;
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
        log.info("WAMP session established with " + params.url);
        for (let procedure in wamp_instance.procedures) {
            if (wamp_instance.procedures.hasOwnProperty(procedure)) wamp_instance.run("register", wamp_instance.procedures[procedure].params);
        }
        for (let subscription in wamp_instance.subscriptions) {
            if (wamp_instance.subscriptions.hasOwnProperty(subscription)) wamp_instance.run("subscribe", wamp_instance.subscriptions[subscription].params);
        }
        wamp_instance.session = session;
        wamp_instance.resolve_connection(wamp_instance);
        wamp_instance.pending_connection = false;
        wamp_instance.onopen(wamp_instance);
    };
    wamp_instance.wamp.onclose = (reason, details) => {
        if (wamp_instance.closed) return;
        wamp_instance.closed = true;
        if (wamp_instance.session) wamp_instance.onclose(wamp_instance);
        log.warn("WAMP session closed with " + params.url + ". Reason: " + reason, details);
        if (!wamp_instance.session || Object.keys(wamp_instance.procedures).length || Object.keys(wamp_instance.subscriptions).length) setTimeout(() => {
            if (!wamp_instance.force_close) {
                wamp_instance.closed = false;
                if (wamp_instance.pending_connection) wamp_instance.wamp.open();
                else wamp_instance.connect();
            }
            else {
                wamp_instance.force_close = false;
                wamp_instance.reject_connection(reason);
            }
        }, 5000);
        wamp_instance.session = undefined;
    };
    wamp_instance.resolve_connection = () => {};
    wamp_instance.reject_connection = () => {};
    return wamp_instance;
}

WAMP.prototype = {
    connect() {
        if (this.session && this.session.isOpen) return this;
        if (!this.pending_connection) this.pending_connection = new Promise((resolve, reject) => {
            if (this.pending_connection) return resolve(this.pending_connection);
            log.verbose("WAMP session starting with " + this.config.url);
            this.resolve_connection = resolve;
            this.reject_connection = reject;
            this.closed = false;
            this.wamp.open();
        });
        return this.pending_connection;
    },
    run(method, params, sync = false, timeout = 60000) {
        let key, rejected = false;
        return new Promise((resolve, reject) => {
            this.queue = Promise.resolve(this.queue)
                .then(() => this.connect())
                .then(session => {
                    if (!method || !params) return resolve(session);
                    if (typeof this.session[method] !== "function") throw "Non-recognized WAMP procedure: " + method;
                    if (method === "unregister" || method === "unsubscribe") {
                        key = params[0];
                        if (typeof key === "string") {//uri is passed as key
                            if (method === "unregister" && this.procedures.hasOwnProperty(key)) params = [this.procedures[key].registration];
                            else if (method === "unsubscribe" && this.subscriptions.hasOwnProperty(key)) params = [this.subscriptions[key].subscription];
                            else throw "Procedure or topic has not been registered";
                        }
                        else {//autobahn subscription/registration is passed as key
                            if (key.procedure && method === "unregister" && this.procedures.hasOwnProperty(key.procedure)) key = key.procedure;
                            else if (key.topic && method === "unsubscribe" && this.subscriptions.hasOwnProperty(key.topic)) key = key.topic;
                            else throw "Procedure or topic has not been registered";
                        }
                    }
                    new Promise((resolve_execution, reject_execution) => {//we do not return the promise to avoid blocking parallel wamp calls
                        let exec = () => {
                            let result = this.session[method](...params);
                            if (result && result.then) {
                                result.then(result => resolve_execution(result))
                                    .catch(err => {
                                        log.error("WAMP error on " + method + " with params: ", params, "Error: ", err);
                                        if (err && err.error === "wamp.error.no_such_procedure" && !rejected) setTimeout(() => exec(), 5000);
                                        else reject_execution(err);
                                    });
                            }
                            else resolve_execution(result);
                        };
                        exec();
                    })
                        .then(result => {
                            if (sync) resolve(result);
                            if (method === "unregister" || method === "unsubscribe") log.silly("Correctly run " + method + " on ", key);
                            else log.silly("Correctly run " + method + " with params: ", params);
                            if (method === "register") this.procedures[params[0]] = {params: params, registration: result};
                            if (method === "subscribe") this.subscriptions[params[0]] = {params: params, subscription: result};
                            if (method === "unregister" && this.procedures.hasOwnProperty(key)) delete this.procedures[key];
                            if (method === "unsubscribe" && this.subscriptions.hasOwnProperty(key)) delete this.subscriptions[key];
                        })
                        .catch(err => {
                            log.error("WAMP error on " + method + " with params: ", params, "Error: ", err);
                            reject(err);
                        });
                })
                .catch(err => {
                    log.error("WAMP error on " + method + " with params: ", params, "Error: ", err);
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
    register(procedure, endpoint, options = {}) {
        return this.run("register", [procedure, endpoint, options], options.sync, options.timeout)
    },
    unregister(procedure, options = {}) {
        return this.run("unregister", [procedure, options], options.sync, options.timeout)
    },
    call(procedure, args, kwargs, options = {}) {
        return this.run("call", [procedure, args, kwargs, options], options.sync, options.timeout)
    },
    subscribe(topic, handler, options = {}) {
        return this.run("subscribe", [topic, handler, options], options.sync, options.timeout)
    },
    unsubscribe(topic, options = {}) {
        return this.run("unsubscribe", [topic, options], options.sync, options.timeout)
    },
    publish(topic, args, kwargs, options = {}) {
        return this.run("publish", [topic, args, kwargs, options], options.sync, options.timeout)
    },
    disconnect() {
        this.reject_connection("disconnect connection command");
        this.pending_connection = false;
        this.force_close = true;
        if (this.session && this.session.isOpen) this.wamp.close();
    },
    reset_pending_connection() {
        this.reject_connection("reset connection command");
        this.pending_connection = false;
    }
};

let instances = {};
let most_recent;
module.exports = ({router, logger, method, params, sync = false, timeout} = {}) => {
    if (!router && most_recent) router = most_recent;
    else if (router && router.save) most_recent = router;

    if (logger) {
        if (typeof logger.info === "function") log.info = logger.info;
        if (typeof logger.warn === "function") log.warn = logger.warn;
        if (typeof logger.error === "function") log.error = logger.error;
        if (typeof logger.debug === "function") log.debug = logger.debug;
        if (typeof logger.verbose === "function") log.verbose = logger.verbose;
        if (typeof logger.silly === "function") log.silly = logger.silly;
    }

    if (!router || !router.hasOwnProperty('url') || !router.hasOwnProperty('realm')) throw ("Missing mandatory fields");

    let key = router.url + ":" + router.realm;

    if (!instances.hasOwnProperty(key)) instances[key] = WAMP(router);
    if (method && params) return instances[key].run(method, params, sync, timeout);
    else return instances[key];
};