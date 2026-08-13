// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';


const BUS_NAME = 'org.pipewire.Telephony';
const MANAGER_PATH = '/org/pipewire/Telephony';
const OBJECT_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';
const AUDIO_GATEWAY_IFACE = 'org.pipewire.Telephony.AudioGateway1';
const CALL_IFACE = 'org.pipewire.Telephony.Call1';
const OFONO_VOICE_CALL_MANAGER_IFACE = 'org.ofono.VoiceCallManager';
const OFONO_VOICE_CALL_IFACE = 'org.ofono.VoiceCall';


/**
 * Unpack a D-Bus property value if it is still wrapped as a variant.
 *
 * @param {object} value - A D-Bus property value
 * @returns {object} The unpacked value
 */
function _unpack(value) {
    return value?.deepUnpack instanceof Function ? value.deepUnpack() : value;
}

/**
 * Normalize a Bluetooth address or GSConnect bluetooth:// URI.
 *
 * @param {string} address - A Bluetooth address or channel URI
 * @returns {string|null} The normalized address
 */
function _normalizeAddress(address) {
    return address?.replace(/^bluetooth:\/\//, '').toUpperCase() ?? null;
}

/**
 * Return the Bluetooth address GSConnect has associated with this device, if
 * available.
 *
 * @param {object} device - A GSConnect device
 * @returns {string|null} The Bluetooth address or %null
 */
function _getDeviceBluetoothAddress(device) {
    const connection = device.settings.get_string('last-connection');

    if (connection.startsWith('bluetooth://'))
        return _normalizeAddress(connection);

    const address = device.settings.get_string('bluetooth-address');

    return address ? _normalizeAddress(address) : null;
}

/**
 * Normalize a phone number for loose comparisons.
 *
 * @param {string} number - A phone number
 * @returns {string} The normalized number
 */
function _normalizeNumber(number) {
    return number?.replace(/[^\d+]/g, '') ?? '';
}

/**
 * Check whether two phone numbers probably refer to the same caller.
 *
 * @param {string} left - A phone number
 * @param {string} right - A phone number
 * @returns {boolean} %true if the numbers are compatible
 */
function _numbersMatch(left, right) {
    left = _normalizeNumber(left);
    right = _normalizeNumber(right);

    if (!left || !right)
        return true;

    return left.endsWith(right) || right.endsWith(left);
}

/**
 * Wait briefly for PipeWire to publish call objects after a state change.
 *
 * @param {number} interval - The wait time in milliseconds
 * @returns {Promise<void>} A promise that resolves after the interval
 */
function _wait(interval) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}


/**
 * PipeWire Bluetooth HFP telephony controls.
 *
 * PipeWire exposes a user-session D-Bus API when a paired phone is connected
 * as a Bluetooth Hands-Free Audio Gateway.
 */
const BluetoothTelephony = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothTelephony',
}, class BluetoothTelephony extends GObject.Object {

    async _call(path, iface, method, parameters = null, replyType = null) {
        return await Gio.DBus.session.call(
            BUS_NAME,
            path,
            iface,
            method,
            parameters,
            replyType,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        );
    }

    async _getManagedObjects() {
        const reply = await this._call(
            MANAGER_PATH,
            OBJECT_MANAGER_IFACE,
            'GetManagedObjects',
            null,
            new GLib.VariantType('(a{oa{sa{sv}}})')
        );
        return reply.recursiveUnpack()[0];
    }

    async _getCalls(gatewayPath) {
        try {
            const reply = await this._call(
                gatewayPath,
                OFONO_VOICE_CALL_MANAGER_IFACE,
                'GetCalls',
                null,
                new GLib.VariantType('(a{oa{sv}})')
            );
            return reply.recursiveUnpack()[0];
        } catch (e) {
            debug(e, 'Bluetooth org.ofono.VoiceCallManager.GetCalls');
        }

        const objects = await this._getManagedObjects();
        const calls = {};

        for (const [path, interfaces] of Object.entries(objects)) {
            if (!path.startsWith(`${gatewayPath}/`))
                continue;

            const properties = interfaces[CALL_IFACE] ??
                interfaces[OFONO_VOICE_CALL_IFACE];

            if (properties)
                calls[path] = properties;
        }

        return calls;
    }

    async _findGatewayPaths(device) {
        const address = _getDeviceBluetoothAddress(device);
        const objects = await this._getManagedObjects();
        const paths = [];

        if (address === null)
            return paths;

        for (const [path, interfaces] of Object.entries(objects)) {
            const gateway = interfaces[AUDIO_GATEWAY_IFACE];

            if (!gateway)
                continue;

            const gatewayAddress = _normalizeAddress(_unpack(gateway.Address));

            if (gatewayAddress === address)
                paths.push(path);
        }

        return paths;
    }

    hasBluetoothAddress(device) {
        return _getDeviceBluetoothAddress(device) !== null;
    }

    async _findCall(device, phoneNumber, states = null) {
        const gatewayPaths = await this._findGatewayPaths(device);

        for (const gatewayPath of gatewayPaths) {
            const calls = await this._getCalls(gatewayPath);

            for (const [path, properties] of Object.entries(calls)) {
                const state = _unpack(properties.State)?.toLowerCase();
                const line = _unpack(properties.LineIdentification);
                const incomingLine = _unpack(properties.IncomingLine);
                const callPhoneNumber = _unpack(properties.PhoneNumber);
                const name = _unpack(properties.Name);

                if (states !== null && !states.includes(state))
                    continue;

                if (!_numbersMatch(phoneNumber,
                    line || incomingLine || callPhoneNumber || name))
                    continue;

                return path;
            }
        }

        return null;
    }

    async _getCallState(callPath, iface) {
        const reply = await this._call(
            callPath,
            PROPERTIES_IFACE,
            'Get',
            new GLib.Variant('(ss)', [iface, 'State']),
            new GLib.VariantType('(v)')
        );

        return reply.recursiveUnpack()[0]?.toLowerCase();
    }

    async _callPathIsActive(callPath) {
        let state = null;

        try {
            state = await this._getCallState(callPath,
                OFONO_VOICE_CALL_IFACE);
        } catch (e) {
            debug(e, 'Bluetooth org.ofono.VoiceCall.State');

            try {
                state = await this._getCallState(callPath, CALL_IFACE);
            } catch (e) {
                debug(e, 'Bluetooth org.pipewire.Telephony.Call1.State');
                return false;
            }
        }

        return state !== 'disconnected';
    }

    async hasActiveCall(device, phoneNumber = null, callPath = null) {
        if (callPath)
            return await this._callPathIsActive(callPath);

        return await this._findCall(device, phoneNumber) !== null;
    }

    _isBluetoothDevice(device) {
        return device.connection_type === 'bluetooth' &&
            device.settings.get_string('last-connection').startsWith('bluetooth://');
    }

    canControl(device) {
        return this._isBluetoothDevice(device);
    }

    async answerIncomingCall(device, phoneNumber = null, callPath = null) {
        if (callPath) {
            try {
                await this._call(callPath, OFONO_VOICE_CALL_IFACE, 'Answer');
            } catch (e) {
                debug(e, 'Bluetooth org.ofono.VoiceCall.Answer');
                await this._call(callPath, CALL_IFACE, 'Answer');
            }

            return true;
        }

        let path = null;

        try {
            path = await this._findCall(device, phoneNumber, [
                'incoming',
                'waiting',
                'alerting',
            ]);
        } catch (e) {
            debug(e, 'Bluetooth find incoming call');
        }

        if (path !== null) {
            try {
                await this._call(path, OFONO_VOICE_CALL_IFACE, 'Answer');
            } catch (e) {
                debug(e, 'Bluetooth org.ofono.VoiceCall.Answer');
                await this._call(path, CALL_IFACE, 'Answer');
            }
            return path;
        }

        const gatewayPaths = await this._findGatewayPaths(device);

        if (gatewayPaths.length === 0)
            return false;

        try {
            await this._call(gatewayPaths[0], AUDIO_GATEWAY_IFACE,
                'HoldAndAnswer');
        } catch (e) {
            debug(e, 'Bluetooth HoldAndAnswer');
            await this._call(gatewayPaths[0], AUDIO_GATEWAY_IFACE,
                'ReleaseAndAnswer');
        }

        return true;
    }

    async hangupCall(device, phoneNumber = null, callPath = null) {
        const gatewayPaths = await this._findGatewayPaths(device);
        let hangupError = null;

        if (callPath) {
            try {
                await this._call(callPath, OFONO_VOICE_CALL_IFACE, 'Hangup');
                return true;
            } catch (e) {
                hangupError = e;
                debug(e, 'Bluetooth org.ofono.VoiceCall.Hangup');
            }

            try {
                await this._call(callPath, CALL_IFACE, 'Hangup');
                return true;
            } catch (e) {
                hangupError = e;
                debug(e, 'Bluetooth org.pipewire.Telephony.Call1.Hangup');
            }
        }

        const path = await this._findCall(device, phoneNumber);

        if (path !== null) {
            try {
                await this._call(path, OFONO_VOICE_CALL_IFACE, 'Hangup');
                return true;
            } catch (e) {
                hangupError = e;
                debug(e, 'Bluetooth org.ofono.VoiceCall.Hangup');
            }

            try {
                await this._call(path, CALL_IFACE, 'Hangup');
                return true;
            } catch (e) {
                hangupError = e;
                debug(e, 'Bluetooth org.pipewire.Telephony.Call1.Hangup');
            }
        }

        if (gatewayPaths.length === 0)
            return false;

        for (const gatewayPath of gatewayPaths) {
            try {
                await this._call(gatewayPath, OFONO_VOICE_CALL_MANAGER_IFACE,
                    'HangupAll');
                return true;
            } catch (e) {
                hangupError = e;
                debug(e, 'Bluetooth org.ofono.VoiceCallManager.HangupAll');
            }

            try {
                await this._call(gatewayPath, AUDIO_GATEWAY_IFACE,
                    'HangupAll');
                return true;
            } catch (e) {
                hangupError = e;
                debug(e, 'Bluetooth org.pipewire.Telephony.HangupAll');
            }
        }

        throw hangupError;
    }

    async dialCall(device, phoneNumber) {
        if (!phoneNumber)
            return false;

        const gatewayPaths = await this._findGatewayPaths(device);

        if (gatewayPaths.length === 0)
            return false;

        for (const gatewayPath of gatewayPaths) {
            try {
                await this._call(
                    gatewayPath,
                    OFONO_VOICE_CALL_MANAGER_IFACE,
                    'Dial',
                    new GLib.Variant('(s)', [phoneNumber])
                );
                await _wait(500);

                return await this._findCall(device, phoneNumber) ?? true;
            } catch (e) {
                debug(e, 'Bluetooth org.ofono.VoiceCallManager.Dial');
            }

            await this._call(
                gatewayPath,
                AUDIO_GATEWAY_IFACE,
                'Dial',
                new GLib.Variant('(s)', [phoneNumber])
            );
            await _wait(500);

            return await this._findCall(device, phoneNumber) ?? true;
        }

        return false;
    }

    destroy() {}
});

export default BluetoothTelephony;
