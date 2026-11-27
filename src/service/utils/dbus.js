// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GjsPrivate from 'gi://GjsPrivate';
import GLib from 'gi://GLib';


/*
 * Some utility methods
 */

/**
 * Convert a label from kebab-case to CamelCase.
 * Will also remove snake_case separators (without capitalizing)
 *
 * @param {string} string - The label to reformat
 * @returns {string} The CamelCased label
 */
function toDBusCase(string) {
    return string.replace(/(?:^\w|[A-Z]|\b\w)/g, (ltr, offset) => {
        return ltr.toUpperCase();
    }).replace(/[\s_-]+/g, '');
}

/**
 * Convert a label from CamelCase to snake_case.
 *
 * @param {string} string - The label to reformat
 * @returns {string} - The snake_cased label
 */
function toUnderscoreCase(string) {
    return string.replace(/(?:^\w|[A-Z]|_|\b\w)/g, (ltr, offset) => {
        if (ltr === '_')
            return '';

        return (offset > 0) ? `_${ltr.toLowerCase()}` : ltr.toLowerCase();
    }).replace(/[\s-]+/g, '');
}


/**
 * DBus.Interface represents a DBus interface bound to an object instance, meant
 * to be exported over DBus.
 */
export class Interface {
    constructor(params) {
        this._dbus = new GjsPrivate.DBusImplementation({
            g_interface_info: params.g_interface_info,
        });
        this._instance = params.g_instance;

        // Cache member lookups
        this._instanceHandlers = [];
        this._instanceMethods = {};
        this._instanceProperties = {};

        const info = params.g_interface_info;
        this._dbus.connect('handle-method-call',
            this._call.bind(this, info));
        this._dbus.connect('handle-property-get',
            this._get.bind(this, info));
        this._dbus.connect('handle-property-set',
            this._set.bind(this, info));

        // Automatically forward known signals
        const id = this._instance.connect('notify',
            this._notify.bind(this));
        this._instanceHandlers.push(id);

        for (const signal of info.signals) {
            const type = `(${signal.args.map(arg => arg.signature).join('')})`;
            const id = this._instance.connect(signal.name,
                this._emit.bind(this, signal.name, type));

            this._instanceHandlers.push(id);
        }

        // Export if connection and object path were given
        if (params.g_connection && params.g_object_path)
            this.export(params.g_connection, params.g_object_path);
    }

    get dbus() {
        return this._dbus;
    }

    export(connection, objectPath) {
        this._dbus.export(connection, objectPath);
    }

    flush() {
        this._dbus.flush();
    }

    /**
     * Invoke an instance's method for a DBus method call.
     *
     * @param {Gio.DBusInterfaceInfo} info - The DBus interface
     * @param {Gio.DBusInterface} iface - The DBus interface
     * @param {string} name - The DBus method name
     * @param {GLib.Variant|Gio.DBusMethodInvocation} param1
     *        - The method parameters or invocation (GNOME 50+ changed order)
     * @param {Gio.DBusMethodInvocation|GLib.Variant} param2
     *        - The method invocation or parameters (GNOME 50+ changed order)
     */
    async _call(info, _iface, name, param1, param2) {
        let retval;
        let invocation, parameters;

        // GNOME 50+ changed the callback signature from
        // (iface, name, parameters, invocation) to
        // (iface, name, invocation, parameters)
        // Detect which order is being used
        if (param1 instanceof GLib.Variant) {
            // Old order: parameters, invocation
            parameters = param1;
            invocation = param2;
        } else {
            // New order: invocation, parameters
            invocation = param1;
            parameters = param2;
        }

        // Invoke the instance method
        try {
            const args = parameters.unpack().map(parameter => {
                if (parameter.get_type_string() === 'h') {
                    const message = invocation.get_message();
                    const fds = message.get_unix_fd_list();
                    const idx = parameter.deepUnpack();
                    return fds.get(idx);
                } else {
                    return parameter.recursiveUnpack();
                }
            });

            retval = await this._instance[name](...args);
        } catch (e) {
            if (e instanceof GLib.Error) {
                invocation.return_gerror(e);
            } else {
                // likely to be a normal JS error
                if (!e.name.includes('.'))
                    e.name = `org.gnome.gjs.JSError.${e.name}`;

                invocation.return_dbus_error(e.name, e.message);
            }

            logError(e, `${this._instance}: ${name}`);
            return;
        }

        // `undefined` is an empty tuple on DBus
        if (retval === undefined)
            retval = new GLib.Variant('()', []);

        // Return the instance result or error
        try {
            if (!(retval instanceof GLib.Variant)) {
                const args = info.lookup_method(name).out_args;
                retval = new GLib.Variant(
                    `(${args.map(arg => arg.signature).join('')})`,
                    (args.length === 1) ? [retval] : retval
                );
            }

            invocation.return_value(retval);
        } catch (e) {
            invocation.return_dbus_error(
                'org.gnome.gjs.JSError.ValueError',
                'Service implementation returned an incorrect value type'
            );

            logError(e, `${this}: ${name}`);
        }
    }

    _nativeProp(name) {
        if (this._instanceProperties[name] === undefined) {
            let propName = name;

            if (propName in this._instance)
                this._instanceProperties[name] = propName;

            if (this._instanceProperties[name] === undefined) {
                propName = toUnderscoreCase(name);

                if (propName in this._instance)
                    this._instanceProperties[name] = propName;
            }
        }

        return this._instanceProperties[name];
    }

    _emit(name, type, obj, ...args) {
        this._dbus.emit_signal(name, new GLib.Variant(type, args));
    }

    _get(info, _iface, name) {
        const nativeValue = this._instance[this._nativeProp(name)];
        const propertyInfo = info.lookup_property(name);

        if (nativeValue === undefined || propertyInfo === null)
            return null;

        return new GLib.Variant(propertyInfo.signature, nativeValue);
    }

    _set(info, _iface, name, value) {
        const nativeValue = value.recursiveUnpack();

        this._instance[this._nativeProp(name)] = nativeValue;
    }

    _notify(obj, pspec) {
        const name = toDBusCase(pspec.name);
        const propertyInfo = this._dbus.get_info().lookup_property(name);

        if (propertyInfo === null)
            return;

        this._dbus.emit_property_changed(
            name,
            new GLib.Variant(
                propertyInfo.signature,
                // Adjust for GJS's '-'/'_' conversion
                this._instance[pspec.name.replace(/-/gi, '_')]
            )
        );
    }

    destroy() {
        try {
            for (const id of this._instanceHandlers)
                this._instance.disconnect(id);
            this._instanceHandlers = [];

            this.flush();
            this._dbus.unexport();
        } catch (e) {
            logError(e);
        }
    }
}

/**
 * Get a new, dedicated DBus connection on {@link busType}
 *
 * @param {Gio.BusType} [busType] - a Gio.BusType constant
 * @param {Gio.Cancellable} [cancellable] - an optional Gio.Cancellable
 * @returns {Promise<Gio.DBusConnection>} A new DBus connection
 */
export function newConnection(busType = Gio.BusType.SESSION, cancellable = null) {
    return new Promise((resolve, reject) => {
        Gio.DBusConnection.new_for_address(
            Gio.dbus_address_get_for_bus_sync(busType, cancellable),
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
            Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            null,
            cancellable,
            (connection, res) => {
                try {
                    resolve(Gio.DBusConnection.new_for_address_finish(res));
                } catch (e) {
                    reject(e);
                }
            }
        );

    });
}
