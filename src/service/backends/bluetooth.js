// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Config from '../../config.js';
import * as Core from '../core.js';
import Device from '../device.js';
import * as DBus from '../utils/dbus.js';

let GioUnix;
try {
    GioUnix = (await import('gi://GioUnix')).default;
} catch {
    GioUnix = {
        InputStream: Gio.UnixInputStream,
        OutputStream: Gio.UnixOutputStream,
    };
}

try {
    Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async',
        'read_bytes_finish');
} catch {
    // Already promisified by another import.
}

const BLUEZ_NAME = 'org.bluez';
const BLUEZ_PATH = '/org/bluez';
const PROFILE_PATH = `${Config.APP_PATH}/BluetoothProfile`;
const SERVICE_UUID = '185f3df4-3268-4e3f-9fca-d4d5059915bd';
const DEFAULT_CHANNEL_UUID = 'a0d0aaf4-1072-4d81-aa35-902a954b1266';
const RFCOMM_CHANNEL = 6;

const MESSAGE_PROTOCOL_VERSION = 0;
const MESSAGE_OPEN_CHANNEL = 1;
const MESSAGE_CLOSE_CHANNEL = 2;
const MESSAGE_READ = 3;
const MESSAGE_WRITE = 4;
const MULTIPLEX_PROTOCOL_VERSION = 1;
const BUFFER_SIZE = 65535; // Max for uint16 MESSAGE_READ. Avoids overflow.
const CONTROL_BUFFER_SIZE = 4096;
const RECONNECT_COOLDOWN = 30000;
const OUTBOUND_HANDSHAKE_GRACE = 15000;
const CONNECT_OUTGOING = GLib.getenv('GSCONNECT_BLUETOOTH_CONNECT') === '1';

/**
 * @typedef {(
 *   GLib.Variant|object|string|string[]|number|boolean|null|undefined
 * )} DBusValue
 */

const PROFILE_XML = `
<node>
  <interface name="org.bluez.Profile1">
    <method name="Release"/>
    <method name="NewConnection">
      <arg type="o" name="device" direction="in"/>
      <arg type="h" name="fd" direction="in"/>
      <arg type="a{sv}" name="fd_properties" direction="in"/>
    </method>
    <method name="RequestDisconnection">
      <arg type="o" name="device" direction="in"/>
    </method>
  </interface>
</node>`;

const PROFILE_IFACE = Gio.DBusNodeInfo.new_for_xml(PROFILE_XML)
    .interfaces[0];

/**
 * Clamp a number to a byte.
 *
 * @param {number} value - An integer
 * @returns {number} A byte value
 */
function _byte(value) {
    return value & 0xff;
}

/**
 * Encode an unsigned 16-bit integer as big-endian bytes.
 *
 * @param {number} value - An integer
 * @returns {number[]} Two big-endian bytes
 */
export function _uint16(value) {
    return [_byte(value >> 8), _byte(value)];
}

/**
 * Decode an unsigned 16-bit integer from big-endian bytes.
 *
 * @param {Uint8Array} bytes - A byte buffer
 * @param {number} offset - The byte offset
 * @returns {number} The decoded integer
 */
export function _readUint16(bytes, offset) {
    return (bytes[offset] << 8) | bytes[offset + 1];
}

/**
 * Encode a UUID string as 16 bytes.
 *
 * @param {string} uuid - A UUID string
 * @returns {number[]} The UUID bytes
 */
export function _uuidToBytes(uuid) {
    return uuid.replaceAll('-', '').match(/../g)
        .map(byte => parseInt(byte, 16));
}

/**
 * Decode a UUID string from 16 bytes.
 *
 * @param {Uint8Array} bytes - The UUID bytes
 * @returns {string} A UUID string
 */
export function _bytesToUuid(bytes) {
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'))
        .join('');

    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20),
    ].join('-');
}

/**
 * Serialize a packet as UTF-8 bytes.
 *
 * @param {Core.Packet} packet - A KDE Connect packet
 * @returns {Uint8Array} The serialized packet
 */
function _packetToBytes(packet) {
    return new TextEncoder().encode(packet.serialize());
}

/**
 * Infer a Bluetooth address from a BlueZ object path.
 *
 * @param {string} path - A BlueZ device object path
 * @returns {string} A Bluetooth address or fallback path component
 */
function _addressFromObjectPath(path) {
    return path.split('/').at(-1)?.replaceAll('_', ':') ?? path;
}

/**
 * Unpack a D-Bus property value if it is still wrapped as a variant.
 *
 * @param {DBusValue} value - A D-Bus property value
 * @returns {DBusValue} The unpacked value
 */
export function _unpackVariant(value) {
    return value?.deepUnpack instanceof Function ? value.deepUnpack() : value;
}

/**
 * Return the PEM text for a certificate.
 *
 * @param {Gio.TlsCertificate} certificate - A TLS certificate
 * @returns {string} The PEM encoded certificate
 */
function _certificatePem(certificate) {
    if (!certificate)
        return '';

    return certificate.certificate_pem ?? '';
}

/**
 * Ensure certificate text is PEM wrapped.
 *
 * @param {string} pem - Certificate text
 * @returns {string} A PEM encoded certificate
 */
export function _normalizeCertificatePem(pem) {
    if (!pem)
        return '';

    if (pem.startsWith('-----BEGIN CERTIFICATE-----'))
        return pem;

    return `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----\n`;
}

/**
 * Read an exact number of bytes from an input stream.
 *
 * @param {Gio.InputStream} stream - An input stream
 * @param {number} size - The number of bytes to read
 * @param {Gio.Cancellable} cancellable - A cancellable
 * @returns {Promise<Uint8Array>} The bytes read
 */
async function _readBytes(stream, size, cancellable = null) {
    const result = new Uint8Array(size);
    let offset = 0;

    while (offset < size) {
        const bytes = await stream.read_bytes_async(size - offset,
            GLib.PRIORITY_DEFAULT, cancellable);
        const data = bytes.toArray();

        if (data.length === 0) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.CLOSED,
                message: 'Stream is closed',
            });
        }

        result.set(data, offset);
        offset += data.length;
    }

    return result;
}

/**
 * Safely write a Uint8Array to a Gio.OutputStream asynchronously.
 * Workaround for GJS bug where write_all_async corrupts memory.
 */
function _writeBytesAsync(stream, data, cancellable = null) {
    return new Promise((resolve, reject) => {
        const bytes = data instanceof GLib.Bytes ? data : new GLib.Bytes(data);
        stream.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
            try {
                resolve(s.write_bytes_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

class MultiplexChannel {

    constructor(multiplexer, uuid, bufferSize = BUFFER_SIZE) {
        this.multiplexer = multiplexer;
        this.uuid = uuid;
        this.bufferSize = bufferSize;
        this.connected = true;
        this.closeAfterWrite = false;
        this.freeWriteAmount = 0;
        this.readBuffer = [];
        this.readBufferIndex = 0;
        this.readLength = 0;
        this.readWaiters = [];
        this.requestedReadAmount = 0;
        this.writeBuffer = [];
        this.writeBufferIndex = 0;
        this.writeLength = 0;
        this.writeWaiters = [];
    }

    get closed() {
        return !this.connected && this.readLength === 0;
    }

    _appendRead(data) {
        this.readBuffer.push(data);
        this.readLength += data.length;
        this._wakeReaders();

        this._requestRead();
    }

    _appendWrite(data) {
        this.writeBuffer.push(data);
        this.writeLength += data.length;
        this.multiplexer._flush();
    }

    _consumeRead(size) {
        const amount = Math.min(size, this.readLength);
        const result = new Uint8Array(amount);
        let offset = 0;

        while (offset < amount) {
            const chunk = this.readBuffer[this.readBufferIndex];
            const take = Math.min(chunk.length, amount - offset);

            result.set(chunk.slice(0, take), offset);
            offset += take;

            if (take === chunk.length) {
                this.readBuffer[this.readBufferIndex] = null;
                this.readBufferIndex++;
            } else {
                this.readBuffer[this.readBufferIndex] = chunk.slice(take);
            }
        }

        this.readLength -= amount;

        if (this.readBufferIndex > 500) {
            this.readBuffer = this.readBuffer.slice(this.readBufferIndex);
            this.readBufferIndex = 0;
        }
        this._requestRead();
        return result;
    }

    _consumeWrite(size) {
        const amount = Math.min(size, this.writeLength);
        const result = new Uint8Array(amount);
        let offset = 0;

        while (offset < amount) {
            const chunk = this.writeBuffer[this.writeBufferIndex];
            const take = Math.min(chunk.length, amount - offset);

            result.set(chunk.slice(0, take), offset);
            offset += take;

            if (take === chunk.length) {
                this.writeBuffer[this.writeBufferIndex] = null;
                this.writeBufferIndex++;
            } else {
                this.writeBuffer[this.writeBufferIndex] = chunk.slice(take);
            }
        }

        this.writeLength -= amount;

        if (this.writeBufferIndex > 500) {
            this.writeBuffer = this.writeBuffer.slice(this.writeBufferIndex);
            this.writeBufferIndex = 0;
        }
        return result;
    }

    _requestRead() {
        if (this.closed)
            return;

        const pending = this.readLength + this.requestedReadAmount;

        // Optimization: For bulk transfers, wait until half the buffer is consumed.
        // For the default control channel (mouse), refill the window earlier (at 75%)
        // to prevent window starvation which causes micro-stutters.
        const threshold = this.uuid === DEFAULT_CHANNEL_UUID
            ? this.bufferSize * 0.75
            : this.bufferSize / 2;

        if (pending > threshold)
            return;

        const amount = this.bufferSize - pending;
        this.requestedReadAmount += amount;
        this.multiplexer._sendMessage(MESSAGE_READ, this.uuid, _uint16(amount));
    }

    _wakeReaders() {
        const waiters = this.readWaiters.splice(0);

        for (const resolve of waiters)
            resolve();
    }

    _wakeWriters() {
        const waiters = this.writeWaiters.splice(0);

        for (const resolve of waiters)
            resolve();
    }

    async _waitForReadable(cancellable = null) {
        while (this.readLength === 0) {
            if (this.closed) {
                throw new Gio.IOErrorEnum({
                    code: Gio.IOErrorEnum.CLOSED,
                    message: 'Channel is closed',
                });
            }

            if (cancellable?.is_cancelled()) {
                throw new Gio.IOErrorEnum({
                    code: Gio.IOErrorEnum.CANCELLED,
                    message: 'Operation was cancelled',
                });
            }

            await new Promise(resolve => this.readWaiters.push(resolve));
        }
    }

    async read(size = BUFFER_SIZE, cancellable = null) {
        try {
            await this._waitForReadable(cancellable);
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CLOSED))
                return new Uint8Array(0);
            throw e;
        }
        return this._consumeRead(size);
    }

    async readLine(cancellable = null) {
        const chunks = [];
        let length = 0;

        while (true) {
            await this._waitForReadable(cancellable);

            let newline = -1;
            let offset = 0;

            for (let i = this.readBufferIndex; i < this.readBuffer.length; i++) {
                const chunk = this.readBuffer[i];
                newline = chunk.indexOf(0x0a);

                if (newline !== -1) {
                    newline += offset;
                    break;
                }

                offset += chunk.length;
            }

            if (newline === -1) {
                chunks.push(this._consumeRead(this.readLength));
                length += chunks.at(-1).length;
                continue;
            }

            chunks.push(this._consumeRead(newline + 1));
            length += chunks.at(-1).length;
            break;
        }

        const result = new Uint8Array(length);
        let offset = 0;

        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }

        const decodedLine = new TextDecoder().decode(result);
        return decodedLine;
    }

    async write(data, cancellable = null) {
        if (typeof data === 'string')
            data = new TextEncoder().encode(data);

        if (!this.connected) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.CLOSED,
                message: 'Channel is closed',
            });
        }

        this._appendWrite(data);

        while (this.writeLength > 0) {
            if (!this.connected) {
                throw new Gio.IOErrorEnum({
                    code: Gio.IOErrorEnum.CLOSED,
                    message: 'Channel is closed',
                });
            }

            if (cancellable?.is_cancelled()) {
                throw new Gio.IOErrorEnum({
                    code: Gio.IOErrorEnum.CANCELLED,
                    message: 'Operation was cancelled',
                });
            }

            await new Promise(resolve => this.writeWaiters.push(resolve));
        }
    }

    close() {
        if (!this.connected)
            return;

        this.closeAfterWrite = true;
        this.multiplexer._flush();
    }

    _finishClose() {
        this.connected = false;
        this._wakeReaders();
        this._wakeWriters();
    }
}

class ConnectionMultiplexer {

    constructor(connection, cancellable = null) {
        this.connection = connection;
        this.cancellable = cancellable ?? new Gio.Cancellable();
        this.input_stream = connection.input_stream;
        this.output_stream = connection.output_stream;
        this.channels = new Map();
        this.closed = false;
        this.receivedProtocolVersion = false;
        this.writeQueue = [];
        this.writeQueueIndex = 0;
        this.writeLock = false;

        this._sendMessage(MESSAGE_PROTOCOL_VERSION, DEFAULT_CHANNEL_UUID, [
            ..._uint16(MULTIPLEX_PROTOCOL_VERSION),
            ..._uint16(MULTIPLEX_PROTOCOL_VERSION),
        ]);
        this._addChannel(DEFAULT_CHANNEL_UUID, true, CONTROL_BUFFER_SIZE);
        this._readLoop();
    }

    get defaultChannel() {
        return this.channels.get(DEFAULT_CHANNEL_UUID);
    }

    _addChannel(uuid, requestRead = true, bufferSize = BUFFER_SIZE) {
        if (this.channels.has(uuid))
            return this.channels.get(uuid);

        const channel = new MultiplexChannel(this, uuid, bufferSize);
        this.channels.set(uuid, channel);

        if (requestRead)
            channel._requestRead();

        return channel;
    }

    _sendMessage(type, uuid, data = []) {
        if (this.closed)
            return;

        data = data instanceof Uint8Array ? data : new Uint8Array(data);

        const message = new Uint8Array(19 + data.length);
        message[0] = type;
        message.set(_uint16(data.length), 1);
        message.set(_uuidToBytes(uuid), 3);
        message.set(data, 19);

        this.writeQueue.push(message);
        this._flush();
    }

    async _flush() {
        if (this.writeLock || this.closed)
            return;

        this.writeLock = true;

        try {
            while (this.writeQueueIndex < this.writeQueue.length) {
                const message = this.writeQueue[this.writeQueueIndex];

                await _writeBytesAsync(this.output_stream, message, this.cancellable);

                this.writeQueue[this.writeQueueIndex] = null;
                this.writeQueueIndex++;
                
                if (this.writeQueueIndex > 500) {
                    this.writeQueue = this.writeQueue.slice(this.writeQueueIndex);
                    this.writeQueueIndex = 0;
                }
            }

            for (const [uuid, channel] of this.channels) {
                while (channel.writeLength > 0 && channel.freeWriteAmount > 0) {
                    const amount = Math.min(channel.writeLength,
                        channel.freeWriteAmount, channel.bufferSize);
                    const data = channel._consumeWrite(amount);

                    channel.freeWriteAmount -= amount;
                    this._sendMessage(MESSAGE_WRITE, uuid, data);
                    channel._wakeWriters();
                }

                if (channel.writeLength === 0 && channel.closeAfterWrite)
                    this._closeChannel(uuid);
            }
        } catch (e) {
            debug(e, 'Bluetooth Multiplexer');
            this.close();
        } finally {
            this.writeLock = false;

            if (this.writeQueue.length > this.writeQueueIndex ||
                Array.from(this.channels.values())
                    .some(channel => channel.writeLength > 0 &&
                          channel.freeWriteAmount > 0))
                this._flush();
        }
    }

    async _readLoop() {
        try {
            while (!this.closed) {
                const header = await _readBytes(this.input_stream, 19,
                    this.cancellable);
                const type = header[0];
                const length = _readUint16(header, 1);
                const uuid = _bytesToUuid(header.slice(3, 19));
                const data = await _readBytes(this.input_stream, length,
                    this.cancellable);

                this._handleMessage(type, uuid, data);
            }
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                debug(e, 'Bluetooth Multiplexer');

            this.close();
        }
    }

    _handleMessage(type, uuid, data) {
        if (!this.receivedProtocolVersion &&
            type !== MESSAGE_PROTOCOL_VERSION) {
            this.close();
            return;
        }

        switch (type) {
            case MESSAGE_PROTOCOL_VERSION: {
                const lowest = _readUint16(data, 0);
                const highest = _readUint16(data, 2);

                if (lowest > MULTIPLEX_PROTOCOL_VERSION || highest < 1)
                    this.close();
                else
                    this.receivedProtocolVersion = true;

                break;
            }

            case MESSAGE_OPEN_CHANNEL:
                this._addChannel(uuid);
                break;

            case MESSAGE_CLOSE_CHANNEL:
                this._removeChannel(uuid);
                break;

            case MESSAGE_READ: {
                const channel = this.channels.get(uuid);

                if (channel && channel.connected) {
                    channel.freeWriteAmount += _readUint16(data, 0);
                    this._flush();
                }

                break;
            }

            case MESSAGE_WRITE: {
                const channel = this.channels.get(uuid);

                if (channel && channel.connected) {
                    channel.requestedReadAmount = Math.max(
                        0, channel.requestedReadAmount - data.length);
                    channel._appendRead(data);
                }

                break;
            }
        }
    }

    newChannel() {
        const uuid = GLib.uuid_string_random();
        const channel = this._addChannel(uuid, false);
        this._sendMessage(MESSAGE_OPEN_CHANNEL, uuid);
        channel._requestRead();
        return uuid;
    }

    getChannel(uuid) {
        return this.channels.get(uuid) ?? null;
    }

    _closeChannel(uuid) {
        const channel = this.channels.get(uuid);

        if (!channel)
            return;

        this.channels.delete(uuid);
        channel._finishClose();
        this._sendMessage(MESSAGE_CLOSE_CHANNEL, uuid);
    }

    _removeChannel(uuid) {
        const channel = this.channels.get(uuid);

        if (!channel)
            return;

        this.channels.delete(uuid);
        channel._finishClose();
    }

    close() {
        if (this.closed)
            return;

        this.closed = true;
        this.cancellable.cancel();

        for (const channel of this.channels.values())
            channel._finishClose();

        this.channels.clear();

        try {
            this.connection.close_async(GLib.PRIORITY_DEFAULT, null, null);
        } catch {
            // Best-effort cleanup.
        }
    }
}

export const _testInternals = {
    ConnectionMultiplexer,
    MultiplexChannel,
};

const BluetoothProfile = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothProfile',
}, class BluetoothProfile extends GObject.Object {

    _init(service) {
        super._init();
        this.service = service;
    }

    Release() {
        this.service.stop();
    }

    NewConnection(device, fd, properties) {
        this.service._onNewConnection(device, fd, properties).catch(e => {
            logError(e, 'Bluetooth');
        });
    }

    RequestDisconnection(device) {
        this.service._closeDevice(device);
    }
});

export const ChannelService = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothChannelService',
    Properties: {
        'certificate': GObject.ParamSpec.object(
            'certificate',
            'Certificate',
            'The local TLS certificate',
            GObject.ParamFlags.READWRITE,
            Gio.TlsCertificate.$gtype
        ),
    },
}, class BluetoothChannelService extends Core.ChannelService {

    _init(params = {}) {
        super._init(params);

        this._channels = new Map();
        this._connecting = new Set();
        this._cooldowns = new Map();
        this._devices = new Map();
        this._objects = new Map();
        this._outbound = new Map();
        this._pending = new Set();
        this._profile = new BluetoothProfile(this);
        this._profileIface = new DBus.Interface({
            g_instance: this._profile,
            g_interface_info: PROFILE_IFACE,
        });
        this._profileExported = false;
        this._profileRegistered = false;
    }

    get address() {
        return 'bluetooth';
    }

    get certificate() {
        if (this._certificate === undefined)
            this._certificate = null;

        return this._certificate;
    }

    set certificate(certificate) {
        if (this.certificate === certificate)
            return;

        this._certificate = certificate;
        this.notify('certificate');
    }

    get channels() {
        return this._channels;
    }

    _initCertificate() {
        const certPath = GLib.build_filenamev([
            Config.CONFIGDIR,
            'certificate.pem',
        ]);
        const keyPath = GLib.build_filenamev([
            Config.CONFIGDIR,
            'private.pem',
        ]);

        this._certificate = Gio.TlsCertificate.new_for_paths(certPath, keyPath,
            null);
    }

    _identityWithCertificate() {
        const identity = new Core.Packet(this.identity);
        identity.body.certificate = _certificatePem(this.certificate);
        return identity;
    }

    async _registerProfile() {
        if (!this._profileExported) {
            this._profileIface.export(Gio.DBus.system, PROFILE_PATH);
            this._profileExported = true;
        }

        let record = '';

        try {
            const bytes = Gio.resources_lookup_data(
                GLib.build_filenamev([Config.APP_PATH,
                    `${Config.APP_ID}.sdp.xml`]),
                Gio.ResourceLookupFlags.NONE
            );
            record = new TextDecoder().decode(bytes.toArray());
        } catch (e) {
            debug(e, 'Bluetooth SDP');
        }

        const options = {
            Name: GLib.Variant.new_string('GSConnect'),
            Service: GLib.Variant.new_string(SERVICE_UUID),
            RequireAuthentication: GLib.Variant.new_boolean(true),
            RequireAuthorization: GLib.Variant.new_boolean(false),
            Channel: GLib.Variant.new_uint16(RFCOMM_CHANNEL),
            AutoConnect: GLib.Variant.new_boolean(false),
        };

        if (record)
            options.ServiceRecord = GLib.Variant.new_string(record);

        await Gio.DBus.system.call(
            BLUEZ_NAME,
            BLUEZ_PATH,
            'org.bluez.ProfileManager1',
            'RegisterProfile',
            new GLib.Variant('(osa{sv})', [PROFILE_PATH, SERVICE_UUID,
                options]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            this.cancellable
        );

        this._profileRegistered = true;
        debug('Bluetooth profile registered');
    }

    async _connectDevice(path) {
        const address = this._devices.get(path) ?? _addressFromObjectPath(path);
        const retryAt = this._cooldowns.get(address) ?? 0;

        if (this.channels.has(`bluetooth://${address}`) ||
            this._connecting.has(path) ||
            this._pending.has(address) ||
            Date.now() < retryAt)
            return;

        this._connecting.add(path);
        this._outbound.set(address, Date.now() + OUTBOUND_HANDSHAKE_GRACE);

        try {
            await Gio.DBus.system.call(
                BLUEZ_NAME,
                path,
                'org.bluez.Device1',
                'ConnectProfile',
                new GLib.Variant('(s)', [SERVICE_UUID]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                this.cancellable
            );
        } catch (e) {
            debug(e, 'Bluetooth ConnectProfile');
            this._outbound.delete(address);
            this._cooldowns.set(address, Date.now() + RECONNECT_COOLDOWN);
        } finally {
            this._connecting.delete(path);
        }
    }

    async _loadDevices() {
        const reply = await Gio.DBus.system.call(
            BLUEZ_NAME,
            '/',
            'org.freedesktop.DBus.ObjectManager',
            'GetManagedObjects',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            this.cancellable
        );

        const [objects] = reply.recursiveUnpack();

        for (const [path, interfaces] of Object.entries(objects)) {
            const device = interfaces['org.bluez.Device1'];

            if (!device)
                continue;

            const address = _unpackVariant(device.Address) ??
                _addressFromObjectPath(path);
            const uuids = _unpackVariant(device.UUIDs) ?? [];

            this._objects.set(address, path);
            this._devices.set(path, address);

            if (uuids.map(uuid => uuid.toLowerCase()).includes(SERVICE_UUID)) {
                debug(`Bluetooth service available on ${address}`);

                if (CONNECT_OUTGOING)
                    this._connectDevice(path);
            }
        }
    }

    async _onNewConnection(device, fd, properties) {
        const address = this._devices.get(device) ??
            _addressFromObjectPath(device);
        const channelAddress = `bluetooth://${address}`;
        const initiated = Date.now() < (this._outbound.get(address) ?? 0);
        debug(`Bluetooth NewConnection from ${address} (${initiated ? 'outgoing' : 'incoming'})`);

        if (this.channels.has(channelAddress) || this._pending.has(address)) {
            try {
                new GioUnix.InputStream({fd, close_fd: true}).close(null);
            } catch {
                // Best-effort cleanup for duplicate connections.
            }

            return;
        }

        this._devices.set(device, address);
        this._objects.set(address, device);
        this._pending.add(address);

        const connection = new Gio.SimpleIOStream({
            input_stream: new GioUnix.InputStream({fd, close_fd: true}),
            output_stream: new GioUnix.OutputStream({fd, close_fd: false}),
        });
        const channel = new Channel({
            backend: this,
            address,
            identity: null,
            initiated,
        });
        const multiplexer = new ConnectionMultiplexer(connection,
            channel.cancellable);
        channel.multiplexer = multiplexer;

        try {
            await channel.open();

            this.channels.set(channel.address, channel);
            this._cooldowns.delete(address);
            this.channel(channel);
        } catch (e) {
            this._cooldowns.set(address, Date.now() + RECONNECT_COOLDOWN);
            throw e;
        } finally {
            this._outbound.delete(address);
            this._pending.delete(address);
        }
    }

    _onChannelClosed(address) {
        this._cooldowns.set(address, Date.now() + RECONNECT_COOLDOWN);
    }

    _closeDevice(device) {
        const address = this._devices.get(device) ??
            _addressFromObjectPath(device);
        const channel = this.channels.get(`bluetooth://${address}`);

        if (channel)
            channel.close();
    }

    broadcast() {
        if (!this.active)
            return;

        this._loadDevices().catch(e => debug(e, 'Bluetooth Discovery'));
    }

    buildIdentity() {
        super.buildIdentity();
        this.identity.body.bluetoothHost = this.address;
    }

    async _start() {
        await this._registerProfile();
        this._loadDevices().catch(e => debug(e, 'Bluetooth Discovery'));

        this._active = true;
        this.notify('active');
    }

    start() {
        if (this.active)
            return;

        if (this.certificate === null)
            this._initCertificate();

        this._start().catch(e => {
            if (Gio.Application.get_default())
                Gio.Application.get_default().notify_error(e);
            else
                logError(e, 'Bluetooth');
        });
    }

    stop() {
        this._connecting.clear();
        this._cooldowns.clear();
        this._outbound.clear();
        this._pending.clear();

        if (this._profileRegistered) {
            try {
                Gio.DBus.system.call(
                    BLUEZ_NAME,
                    BLUEZ_PATH,
                    'org.bluez.ProfileManager1',
                    'UnregisterProfile',
                    new GLib.Variant('(o)', [PROFILE_PATH]),
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null
                );
            } catch (e) {
                debug(e, 'Bluetooth');
            }

            this._profileRegistered = false;
        }

        for (const channel of this.channels.values())
            channel.close();

        this._active = false;
        this.notify('active');
    }

    destroy() {
        try {
            this.stop();

            if (this._profileExported) {
                this._profileIface.destroy();
                this._profileExported = false;
            }
        } catch (e) {
            debug(e);
        }
    }
});

export const Channel = GObject.registerClass({
    GTypeName: 'GSConnectBluetoothChannel',
}, class BluetoothChannel extends Core.Channel {

    _init(params) {
        super._init();
        Object.assign(this, params);
    }

    get address() {
        return `bluetooth://${this._address}`;
    }

    set address(address) {
        this._address = address;
    }

    get peer_certificate() {
        if (this._peer_certificate === undefined)
            this._peer_certificate = null;

        return this._peer_certificate;
    }

    _validateIdentity(identity) {
        if (!identity.body.deviceId)
            throw new Error('missing deviceId');

        if (identity.body.deviceId === this.backend.identity.body.deviceId)
            throw new Error('Ignoring self');

        if (!Device.validateId(identity.body.deviceId))
            throw new Error(`invalid deviceId "${identity.body.deviceId}"`);

        if (!identity.body.deviceName)
            throw new Error('missing deviceName');

        if (!Device.validateName(identity.body.deviceName)) {
            const sanitized = Device.sanitizeName(identity.body.deviceName);
            debug(`Sanitized invalid device name "${identity.body.deviceName}" to "${sanitized}"`);
            identity.body.deviceName = sanitized;
        }

        const pem = _normalizeCertificatePem(identity.body.certificate);

        if (pem)
            this._peer_certificate = Gio.TlsCertificate.new_from_pem(pem, -1);

        return identity;
    }

    async open() {
        debug(`${this.address} (${this.uuid})`);

        try {
            const localIdentity = this.backend._identityWithCertificate();

            let data;

            if (this.initiated) {
                data = await this.multiplexer.defaultChannel.readLine(
                    this.cancellable);
                await this.multiplexer.defaultChannel.write(
                    _packetToBytes(localIdentity), this.cancellable);
            } else {
                await this.multiplexer.defaultChannel.write(
                    _packetToBytes(localIdentity), this.cancellable);
                data = await this.multiplexer.defaultChannel.readLine(
                    this.cancellable);
            }

            this.identity = this._validateIdentity(new Core.Packet(data));
        } catch (e) {
            this.close();
            throw e;
        }
    }

    close() {
        if (this.closed)
            return;

        debug(`${this.address} (${this.uuid})`);
        this._closed = true;
        this.notify('closed');

        this.backend.channels.delete(this.address);
        this.backend._onChannelClosed(this._address);
        this.cancellable.cancel();
        this.multiplexer.close();
    }

    readPacket(cancellable = null) {
        if (cancellable === null)
            cancellable = this.cancellable;

        return this.multiplexer.defaultChannel.readLine(cancellable)
            .then(data => new Core.Packet(data));
    }

    async sendPacket(packet, cancellable = null) {
        if (cancellable === null)
            cancellable = this.cancellable;

        await this.multiplexer.defaultChannel.write(_packetToBytes(packet),
            cancellable);
        return true;
    }

    async download(packet, target, cancellable = null) {
        const uuid = packet.payloadTransferInfo.uuid;
        const source = this.multiplexer.getChannel(uuid);

        if (!source) {
            throw new Gio.IOErrorEnum({
                code: Gio.IOErrorEnum.NOT_FOUND,
                message: `No Bluetooth payload channel ${uuid}`,
            });
        }

        let transferred = 0;

        while (transferred < packet.payloadSize) {
            const data = await source.read(Math.min(BUFFER_SIZE,
                packet.payloadSize - transferred), cancellable);

            if (data.length === 0)
                break;

            await _writeBytesAsync(target, data, cancellable);

            transferred += data.length;
        }

        source.close();
        target.close_async(GLib.PRIORITY_DEFAULT, null, null);
    }

    async upload(packet, source, size, cancellable = null) {
        const uuid = this.multiplexer.newChannel();
        const target = this.multiplexer.getChannel(uuid);

        packet.payloadSize = size;
        packet.payloadTransferInfo = {uuid};

        await this.sendPacket(new Core.Packet(packet), cancellable);

        while (true) {
            const bytes = await source.read_bytes_async(BUFFER_SIZE,
                GLib.PRIORITY_DEFAULT, cancellable);

            if (bytes.get_size() === 0)
                break;

            await target.write(bytes.toArray(), cancellable);
        }

        target.close();
        source.close_async(GLib.PRIORITY_DEFAULT, null, null);
    }

    rejectTransfer(packet) {
        if (!packet?.hasPayload())
            return;

        const uuid = packet.payloadTransferInfo.uuid;
        const channel = uuid ? this.multiplexer.getChannel(uuid) : null;

        if (channel)
            channel.close();
    }
});
