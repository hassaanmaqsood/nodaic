/**
 * Observable - Reactive path-based state management
 * Browser compatible (ES Module & Global Window export)
 */

export class Observable {
    constructor(initialValue = {}) {
        this.listeners = {};
        this.value = this._deepClone(initialValue);
    }

    addListener(listener, path = "/", listenerType = "default") {
        if (typeof listener !== "function") {
            throw new Error("Listener must be a function");
        }

        const normalizedPath = this._normalizePath(path);

        if (!this.listeners[normalizedPath]) {
            this.listeners[normalizedPath] = {};
        }

        if (!this.listeners[normalizedPath][listenerType]) {
            this.listeners[normalizedPath][listenerType] = [];
        }

        this.listeners[normalizedPath][listenerType].push(listener);
        return this;
    }

    removeListener(listener, path = "/", listenerType = "default") {
        const normalizedPath = this._normalizePath(path);

        if (!this.listeners[normalizedPath] || !this.listeners[normalizedPath][listenerType]) {
            return this;
        }

        this.listeners[normalizedPath][listenerType] = this.listeners[normalizedPath][listenerType].filter(
            (registeredListener) => registeredListener !== listener
        );

        return this;
    }

    clearListeners(path = "/", listenerType = "default") {
        const normalizedPath = this._normalizePath(path);

        if (this.listeners[normalizedPath] && this.listeners[normalizedPath][listenerType]) {
            this.listeners[normalizedPath][listenerType] = [];
        }

        return this;
    }

    getValue(path = "/") {
        return this._getValueByPath(this._normalizePath(path), this.value);
    }

    setValue(newValue, path = "/", listenerTypes = ["default"]) {
        const normalizedPath = this._normalizePath(path);
        const oldValue = this._getValueByPath(normalizedPath, this.value);

        if (this._deepEqual(oldValue, newValue)) {
            return this;
        }

        this._setValueByPath(normalizedPath, newValue, this.value);

        const typesToNotify = Array.isArray(listenerTypes) ? listenerTypes : [listenerTypes];
        this._notifyListeners(normalizedPath, newValue, oldValue, typesToNotify);

        return this;
    }

    deleteValue(path = "/", listenerTypes = ["default"]) {
        const normalizedPath = this._normalizePath(path);

        if (normalizedPath === "/") {
            throw new Error("Cannot delete root path");
        }

        const oldValue = this._getValueByPath(normalizedPath, this.value);

        if (oldValue === undefined) {
            return this;
        }

        const pathArray = normalizedPath.split("/").filter(key => key.length > 0);
        let current = this.value;

        for (let i = 0; i < pathArray.length - 1; i++) {
            const key = pathArray[i];
            if (!current[key]) return this;
            current = current[key];
        }

        const finalKey = pathArray[pathArray.length - 1];
        delete current[finalKey];

        const typesToNotify = Array.isArray(listenerTypes) ? listenerTypes : [listenerTypes];
        this._notifyListeners(normalizedPath, undefined, oldValue, typesToNotify);

        return this;
    }

    getAll() {
        return this._deepClone(this.value);
    }

    _normalizePath(path) {
        if (!path || path === "/") return "/";
        const cleaned = path.replace(/^\/+|\/+$/g, "");
        return cleaned ? `/${cleaned}` : "/";
    }

    _getValueByPath(path, obj) {
        if (path === "/") return obj;
        const pathArray = path.split("/").filter(key => key.length > 0);
        let current = obj;

        for (const key of pathArray) {
            if (current === null || current === undefined || typeof current !== "object") {
                return undefined;
            }
            current = current[key];
        }

        return current;
    }

    _setValueByPath(path, value, obj) {
        if (path === "/") {
            Object.keys(obj).forEach(key => delete obj[key]);
            if (typeof value === "object" && value !== null) {
                Object.assign(obj, value);
            }
            return;
        }

        const pathArray = path.split("/").filter(key => key.length > 0);
        let current = obj;

        for (let i = 0; i < pathArray.length - 1; i++) {
            const key = pathArray[i];
            if (current[key] === undefined || current[key] === null || typeof current[key] !== "object") {
                current[key] = {};
            }
            current = current[key];
        }

        const finalKey = pathArray[pathArray.length - 1];
        current[finalKey] = value;
    }

    _notifyListeners(changedPath, newValue, oldValue, listenerTypes) {
        listenerTypes.forEach(listenerType => {
            this._notifyPathListeners(changedPath, listenerType, newValue, oldValue, changedPath);
            this._notifyParentListeners(changedPath, listenerType, oldValue, changedPath);
        });
    }

    _notifyPathListeners(path, listenerType, newValue, oldValue, originalPath) {
        if (this.listeners[path] && this.listeners[path][listenerType]) {
            this.listeners[path][listenerType].forEach(listener => {
                try {
                    listener(newValue, oldValue, originalPath);
                } catch (error) {
                    console.error(`Error in listener for path ${path}:`, error);
                }
            });
        }
    }

    _notifyParentListeners(changedPath, listenerType, oldValue, originalPath) {
        if (changedPath === "/") return;
        const pathArray = changedPath.split("/").filter(key => key.length > 0);

        while (pathArray.length > 0) {
            pathArray.pop();
            const parentPath = pathArray.length === 0 ? "/" : `/${pathArray.join("/")}`;
            const currentValue = this.getValue(parentPath);
            this._notifyPathListeners(parentPath, listenerType, currentValue, oldValue, originalPath);
        }
    }

    _deepClone(obj) {
        if (obj === null || typeof obj !== "object") return obj;
        if (obj instanceof Date) return new Date(obj.getTime());
        if (obj instanceof Array) return obj.map(item => this._deepClone(item));
        if (typeof obj === "object") {
            const cloned = {};
            Object.keys(obj).forEach(key => {
                cloned[key] = this._deepClone(obj[key]);
            });
            return cloned;
        }
        return obj;
    }

    _deepEqual(a, b) {
        if (a === b) return true;
        if (a === null || b === null) return a === b;
        if (typeof a !== typeof b) return false;
        if (typeof a !== "object") return a === b;

        if (Array.isArray(a) !== Array.isArray(b)) return false;

        const keysA = Object.keys(a);
        const keysB = Object.keys(b);

        if (keysA.length !== keysB.length) return false;

        for (const key of keysA) {
            if (!keysB.includes(key)) return false;
            if (!this._deepEqual(a[key], b[key])) return false;
        }

        return true;
    }
}

if (typeof window !== 'undefined') {
    window.Observable = Observable;
}
