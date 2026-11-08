// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Config from '../config.js';
import * as Core from './core.js';
import plugins from './plugins/index.js';


/**
 * Seconds to wait before writing the cache to disk, so changes arriving
 * together are written at once.
 */
const CACHE_WRITE_DELAY = 5;

/**
 * Base class for device plugins.
 */
const Plugin = GObject.registerClass({
    GTypeName: 'GSConnectPlugin',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device that owns this plugin',
            GObject.ParamFlags.READABLE,
            GObject.Object
        ),
        'name': GObject.ParamSpec.string(
            'name',
            'Name',
            'The device name',
            GObject.ParamFlags.READABLE,
            null
        ),
    },
}, class Plugin extends GObject.Object {

    _init(device, name, meta = null) {
        super._init();

        this._device = device;
        this._name = name;
        this._meta = meta;

        if (this._meta === null)
            this._meta = plugins[name].Metadata;

        // GSettings
        const schema = Config.GSCHEMA.lookup(this._meta.id, false);

        if (schema !== null) {
            this.settings = new Gio.Settings({
                settings_schema: schema,
                path: `${device.settings.path}plugin/${name}/`,
            });
        }

        // GActions
        this._gactions = [];

        if (this._meta.actions) {
            const menu = this.device.settings.get_strv('menu-actions');

            for (const name in this._meta.actions) {
                const info = this._meta.actions[name];
                this._registerAction(name, menu.indexOf(name), info);
            }
        }
    }

    get cancellable() {
        if (this._cancellable === undefined)
            this._cancellable = new Gio.Cancellable();

        return this._cancellable;
    }

    get device() {
        return this._device;
    }

    get name() {
        return this._name;
    }

    _activateAction(action, parameter) {
        try {
            let args = null;

            if (parameter instanceof GLib.Variant)
                args = parameter.full_unpack();

            if (Array.isArray(args))
                this[action.name](...args);
            else
                this[action.name](args);
        } catch (e) {
            logError(e, action.name);
        }
    }

    _registerAction(name, menuIndex, info) {
        try {
            // Device Action
            const action = new Gio.SimpleAction({
                name: name,
                parameter_type: info.parameter_type,
                enabled: false,
            });
            action.connect('activate', this._activateAction.bind(this));

            this.device.add_action(action);

            // Menu
            if (menuIndex > -1) {
                this.device.addMenuAction(
                    action,
                    menuIndex,
                    info.label,
                    info.icon_name
                );
            }

            this._gactions.push(action);
        } catch (e) {
            logError(e, `${this.device.name}: ${this.name}`);
        }
    }

    /**
     * Called when the device connects.
     */
    connected() {
        // Enabled based on device capabilities, which might change
        const incoming = this.device.settings.get_strv('incoming-capabilities');
        const outgoing = this.device.settings.get_strv('outgoing-capabilities');

        for (const action of this._gactions) {
            const info = this._meta.actions[action.name];

            if (info.incoming.every(type => outgoing.includes(type)) &&
                info.outgoing.every(type => incoming.includes(type)))
                action.set_enabled(true);
        }
    }

    /**
     * Called when the device disconnects.
     */
    disconnected() {
        for (const action of this._gactions)
            action.set_enabled(false);
    }

    /**
     * Called when a packet is received that the plugin is a handler for.
     *
     * @param {Core.Packet} packet - A KDE Connect packet
     */
    handlePacket(packet) {
        throw new GObject.NotImplementedError();
    }

    /**
     * Cache JSON parseable properties on this object for persistence. The
     * filename ~/.cache/gsconnect/<device-id>/<plugin-name>.json will be used
     * to store the properties and values.
     *
     * Calling cacheProperties() opens a JSON cache file and reads any stored
     * properties and values onto the current instance. When destroy()
     * is called the properties are automatically stored in the same file;
     * call queueCacheWrite() to store them earlier.
     *
     * @param {Array} names - A list of this object's property names to cache
     */
    async cacheProperties(names) {
        try {
            this._cacheProperties = names;

            // Ensure the device's cache directory exists
            const cachedir = GLib.build_filenamev([
                Config.CACHEDIR,
                this.device.id,
            ]);
            GLib.mkdir_with_parents(cachedir, 448);

            this._cacheFile = Gio.File.new_for_path(
                GLib.build_filenamev([cachedir, `${this.name}.json`]));

            // Read the cache from disk
            const [contents] = await this._cacheFile.load_contents_async(
                this.cancellable);
            const cache = JSON.parse(new TextDecoder().decode(contents));
            Object.assign(this, cache);
        } catch (e) {
            debug(e.message, `${this.device.name}: ${this.name}`);
        } finally {
            this._cacheReady = true;
            this.cacheLoaded();
        }
    }

    /**
     * Build the contents of the cache file from the cached properties.
     *
     * @returns {string} The JSON contents
     */
    _serializeCache() {
        const cache = {};

        for (const name of this._cacheProperties)
            cache[name] = this[name];

        return JSON.stringify(cache, null, 2);
    }

    /**
     * Write the cached properties to disk shortly, so they are kept if the
     * service stops before destroy() is called. Calls made before the write
     * are coalesced into it.
     */
    queueCacheWrite() {
        if (this._cacheFile === undefined || this._cacheWriteId !== undefined)
            return;

        this._cacheWriteId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW,
            CACHE_WRITE_DELAY, () => {
                this._cacheWriteId = undefined;
                this._writeCache();
                return GLib.SOURCE_REMOVE;
            });
    }

    _writeCache() {
        // Don't replace the file before it was read
        if (!this._cacheReady)
            return;

        // Wait for the previous write to finish, then write the latest state
        if (this._cacheWriting) {
            this._cacheWritePending = true;
            return;
        }

        let contents;

        try {
            contents = new TextEncoder().encode(this._serializeCache());
        } catch (e) {
            debug(e.message, `${this.device.name}: ${this.name}`);
            return;
        }

        this._cacheWriting = true;
        this._cacheFile.replace_contents_bytes_async(
            new GLib.Bytes(contents),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            this.cancellable,
            (file, res) => {
                this._cacheWriting = false;

                try {
                    file.replace_contents_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        debug(e.message, `${this.device.name}: ${this.name}`);
                    return;
                }

                if (this._cacheWritePending) {
                    this._cacheWritePending = false;
                    this._writeCache();
                }
            }
        );
    }

    /**
     * An overridable function that is invoked when the on-disk cache is being
     * cleared. Implementations should use this function to clear any in-memory
     * cache data.
     */
    clearCache() {}

    /**
     * An overridable function that is invoked when the cache is done loading
     */
    cacheLoaded() {}

    /**
     * Unregister plugin actions, write the cache (if applicable) and destroy
     * any dangling signal handlers.
     */
    destroy() {
        // Cancel any pending plugin operations
        if (this._cancellable !== undefined)
            this._cancellable.cancel();

        for (const action of this._gactions) {
            this.device.removeMenuAction(`device.${action.name}`);
            this.device.remove_action(action.name);
        }

        if (this._cacheWriteId !== undefined) {
            GLib.source_remove(this._cacheWriteId);
            this._cacheWriteId = undefined;
        }

        // Write the cache to disk synchronously
        if (this._cacheFile !== undefined) {
            try {
                this._cacheFile.replace_contents(
                    this._serializeCache(),
                    null,
                    false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null
                );
            } catch (e) {
                debug(e.message, `${this.device.name}: ${this.name}`);
            }
        }

        GObject.signal_handlers_destroy(this);
    }
});

export default Plugin;
