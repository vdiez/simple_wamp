module.exports = class {
    constructor() {
        this.timeouts = [];
    }

    setTimeout(f, t) {
        const id = setTimeout(() => {
            f();
            this.clearTimeout(id);
        }, t);
        this.timeouts.push(id);
        return id;
    }

    clearTimeout(id) {
        const i = this.timeouts.indexOf(id);
        this.timeouts.splice(i, 1);
        clearTimeout(id);
    }

    clearAllTimeouts() {
        for (let i = 0; i < this.timeouts.length; i++) {
            clearTimeout(this.timeouts[i]);
        }
        this.timeouts = [];
    }
};
