'use strict';

const autobahn = require('autobahn');

const log = {error() {}, warn() {}, info() {}, verbose() {}, debug() {}, silly() {}};
autobahn.log.warn = () => {};
autobahn.log.warn = () => {};
autobahn.log.debug = () => {};

class WAMP {
    constructor(params) {
        this.config = params;
        if (typeof this.config.max_retries !== 'number') this.config.max_retries = -1;
        if (typeof this.config.initial_retry_delay !== 'number' || this.config.initial_retry_delay < 0) this.config.initial_retry_delay = 1.5;
        if (typeof this.config.retry_delay_growth !== 'number' || this.config.retry_delay_growth < 1) this.config.retry_delay_growth = 1.5;
        if (typeof this.config.max_retry_delay !== 'number' || this.config.max_retry_delay < 1) this.config.max_retry_delay = 300;
        this.session = false;
        this.pending_connection = false;
        this.force_close = false;
        this.procedures = {};
        this.subscriptions = {};
        this.queue = [];
        this.running = false;
        this.resolve_connection = () => {};
        this.reject_connection = () => {};
    }

    reset_delay() {
        this.retries = 0;
        this.delay = this.config.initial_retry_delay;
        if (this.delay > this.config.max_retry_delay) this.delay = this.config.max_retry_delay;
    }

    compute_delay(cb) {
        if (this.config.max_retries < 0 || this.retries < this.config.max_retries) {
            setTimeout(() => {cb();}, this.delay * 1000);
            this.retries++;
            this.delay *= this.config.retry_delay_growth;
            if (this.delay > this.config.max_retry_delay) this.delay = this.config.max_retry_delay;
        }
        else cb({max_retries: true});
    }

    create_wamp() {
        this.wamp = new autobahn.Connection({
            url: this.config.url,
            realm: this.config.realm,
            max_retries: 0,
            tlsConfiguration: this.config.tls || {},
            authmethods: this.config.authmethods || [],
            onchallenge: typeof this.config?.onchallenge === 'function' ? this.config.onchallenge : () => this.config?.onchallenge,
            authid: this.config.authid,
            authextra: this.config.authextra
        });

        this.onopen = typeof this.config.onopen === 'function' ? this.config.onopen : () => {};
        this.onclose = typeof this.config.onclose === 'function' ? this.config.onclose : () => {};

        this.wamp.onopen = (session, details) => {
            this.reset_delay();
            log.info(`WAMP session established with ${this.config.url}`, details);
            for (const procedure in this.procedures) {
                if (this.procedures.hasOwnProperty(procedure)) this.run('register', this.procedures[procedure].params).catch(err => log.error('Failed to register procedure', err));
            }
            for (const subscription in this.subscriptions) {
                if (this.subscriptions.hasOwnProperty(subscription)) this.run('subscribe', this.subscriptions[subscription].params).catch(err => log.error('Failed to subscribe to topic', err));
            }
            this.session = session;
            this.resolve_connection();
            this.pending_connection = false;
            this.onopen(this);
        };
        this.wamp.onclose = (reason, details) => {
            this.wamp.onclose = null;
            if (this.session) this.onclose(this);
            this.session = undefined;

            if (this.force_close) log.warn(`WAMP session explicitly closed with ${this.config.url}`);
            else if (this.pending_connection) { //reuse same promise
                log.warn(`Could not connect with ${this.config.url}. Details:`, reason, details);
                this.create_wamp(); //we try with a new object to avoid multiple onclose events from autobahn
                this.compute_delay(err => {
                    if (err) this.reject_connection(err);
                    else {
                        try {
                            log.warn('Retrying...');
                            this.wamp.open();
                        }
                        catch (e) {log.warn(`Could not open WAMP connection with ${this.config.url}. Error:`, err);}
                    }
                });
            }
            else if (this.queue.length || Object.keys(this.procedures).length || Object.keys(this.subscriptions).length || this.config.always_connected) {
                log.warn(`WAMP session with ${this.config.url} has been lost. Details:`, reason, details);
                this.compute_delay(err => {
                    if (!err) {
                        log.warn('Reconnecting...');
                        this.create_connection();
                        this.pending_connection.catch(() => {});
                    }
                });
            }
            else log.warn(`WAMP session with ${this.config.url} has been lost. No more retries until further WAMP calls. Details:`, reason, details);
        };
    }

    create_connection() {
        log.verbose(`WAMP session starting with ${this.config.url}`);
        this.pending_connection = new Promise((resolve, reject) => {
            this.resolve_connection = resolve;
            this.reject_connection = reject;
            this.create_wamp(); //we try with a new object to avoid multiple onclose events from autobahn
            this.wamp.open();
        });
    }

    async exec({method, params, sync, timeout, continue_retrying_after_timeout = true, retry_if_unregistered, resolve, reject}) {
        let key, rejected = false;
        if (!sync) resolve();
        else if (typeof timeout === 'number') {
            setTimeout(() => {
                if (!continue_retrying_after_timeout) {
                    this.pending_connection = false;
                    this.reject_connection({timeout: true});//if pending_connection has not been resolved yet, we want it to reject
                }
                rejected = true;
                reject({timeout: true});
            }, timeout);
        }

        this.force_close = false;
        if (!this.session?.isOpen) {
            if (!this.pending_connection) {
                this.reset_delay();
                this.create_connection();
            }
            await this.pending_connection;
        }

        if (!method || !params) return resolve(this);
        if (typeof this.session[method] !== 'function') throw `Non-recognized WAMP procedure: ${method}`;
        if (method === 'unregister' || method === 'unsubscribe') {
            key = params[0];
            if (typeof key === 'string') {//uri is passed as key
                if (method === 'unregister' && this.procedures.hasOwnProperty(key)) params = [this.procedures[key].registration];
                else if (method === 'unsubscribe' && this.subscriptions.hasOwnProperty(key)) params = [this.subscriptions[key].subscription];
                else throw 'Procedure or topic has not been registered';
            }
            else if (key.procedure && method === 'unregister' && this.procedures.hasOwnProperty(key.procedure)) key = key.procedure;//autobahn registration is passed as key
            else if (key.topic && method === 'unsubscribe' && this.subscriptions.hasOwnProperty(key.topic)) key = key.topic;//autobahn subscription is passed as key
            else throw 'Procedure or topic has not been registered';
        }
        new Promise((resolve_execution, reject_execution) => {//we do not await the promise to avoid blocking parallel wamp calls
            const exec = async () => {
                const result = await Promise.resolve()
                    .then(() => this.session[method](...params))
                    .catch(err => {
                        if (err?.error === 'wamp.error.no_such_procedure' && retry_if_unregistered && !rejected) return {simple_wamp_retry: true};
                        return {simple_wamp_error: err};
                    });

                if (result?.simple_wamp_retry) setTimeout(() => exec(), 5000);
                else if (result?.simple_wamp_error) reject_execution(result.simple_wamp_error);
                else resolve_execution(result);
            };
            exec();
        })
            .then(result => {
                resolve(result);
                if (method === 'unregister' || method === 'unsubscribe') log.silly(`Correctly run ${method} on ${key}`);
                else log.silly(`Correctly run ${method} with params: `, params);
                if (method === 'register') this.procedures[params[0]] = {params, registration: result};
                if (method === 'subscribe') this.subscriptions[params[0]] = {params, subscription: result};
                if (method === 'unregister' && this.procedures.hasOwnProperty(key)) delete this.procedures[key];
                if (method === 'unsubscribe' && this.subscriptions.hasOwnProperty(key)) delete this.subscriptions[key];
            })
            .catch(err => {
                log.error(`WAMP error on ${method} with params: `, params, err);
                reject(err);
            });
    }

    async loop() {
        if (this.running || !this.queue.length) return;
        this.running = true;
        const {method, params, sync, timeout, retry_if_unregistered, resolve, reject} = this.queue.shift();
        await this.exec({method, params, sync, timeout, retry_if_unregistered, resolve, reject})
            .catch(err => {
                log.error(`WAMP error on ${method} with params: `, params, err);
                reject(err);
            });
        this.running = false;
        this.loop().catch(err => log.error('Error looping WAMP jobs', err));
    }

    run(method, params, sync = false, timeout = 60000, retry_if_unregistered = true) {
        return new Promise((resolve, reject) => {
            this.queue.push({method, params, sync, timeout, retry_if_unregistered, resolve, reject});
            this.loop().catch(err => log.error('Error looping WAMP jobs', err));
        });
    }

    register(procedure, endpoint, options = {}) {
        return this.run('register', [procedure, endpoint, options], options.sync, options.timeout);
    }

    unregister(procedure, options = {}) {
        return this.run('unregister', [procedure, options], options.sync, options.timeout);
    }

    call(procedure, args, kwargs, options = {}) {
        return this.run('call', [procedure, args, kwargs, options], options.sync, options.timeout, options.retry_if_unregistered);
    }

    subscribe(topic, handler, options = {}) {
        return this.run('subscribe', [topic, handler, options], options.sync, options.timeout);
    }

    unsubscribe(topic, options = {}) {
        return this.run('unsubscribe', [topic, options], options.sync, options.timeout);
    }

    publish(topic, args, kwargs, options = {}) {
        return this.run('publish', [topic, args, kwargs, options], options.sync, options.timeout);
    }

    disconnect() {
        this.pending_connection = false;
        while (this.queue.length > 0) this.queue.pop().reject({explicit_disconnect: true});
        this.force_close = true;
        this.reject_connection({explicit_disconnect: true});
        return this.wamp.close();
    }
}

const instances = {};
let most_recent;
module.exports = ({router, logger, method, params, sync = false, timeout} = {}) => {
    if (!router && most_recent) router = most_recent;
    else if (router && router.save) most_recent = router;

    if (logger) {
        if (typeof logger.info === 'function') log.info = logger.info;
        if (typeof logger.warn === 'function') log.warn = logger.warn;
        if (typeof logger.error === 'function') log.error = logger.error;
        if (typeof logger.debug === 'function') log.debug = logger.debug;
        if (typeof logger.verbose === 'function') log.verbose = logger.verbose;
        if (typeof logger.silly === 'function') log.silly = logger.silly;
    }

    if (!router || !router.hasOwnProperty('url') || !router.hasOwnProperty('realm')) throw ('Missing mandatory fields');

    const key = `${router.url}:${router.realm}`;

    if (!instances.hasOwnProperty(key)) instances[key] = new WAMP(router);
    if (method && params) return instances[key].run(method, params, sync, timeout);
    return instances[key];
};
