// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const configPath = GLib.getenv('GSCONNECT_TEST')
    ? `${GLib.getenv('GJS_PATH')}/config.js`
    : GLib.build_filenamev([
        Gio.File.new_for_uri(import.meta.url)
            .get_parent()
            .get_parent()
            .get_parent()
            .get_path(),
        'config.js',
    ]);
const {default: Config} = await import(`file://${configPath}`);

if (GLib.getenv('GSCONNECT_TEST')) {
    Config.PACKAGE_DATADIR = GLib.getenv('GJS_PATH');
    Config.GSETTINGS_SCHEMA_DIR = GLib.getenv('GSETTINGS_SCHEMA_DIR');
}

await import(`file://${Config.PACKAGE_DATADIR}/service/init.js`);

const Bluetooth = await import(`file://${Config.PACKAGE_DATADIR}/service/backends/bluetooth.js`);
const Core = await import(`file://${Config.PACKAGE_DATADIR}/service/core.js`);

const DATA_PATH = Gio.File.new_for_uri(import.meta.url)
    .get_parent()
    .get_parent()
    .get_parent()
    .get_child('data')
    .get_path();


/**
 * Convert a fixture filename into a path within the test datadir.
 *
 * @param {string} filename - A fixture filename
 * @returns {string} An absolute path
 */
function getDataPath(filename) {
    return GLib.build_filenamev([DATA_PATH, filename]);
}


/**
 * Build a remote identity packet for channel handshake tests.
 *
 * @returns {string} A serialized identity packet
 */
function getRemoteIdentity() {
    return new Core.Packet({
        type: 'kdeconnect.identity',
        body: {
            deviceId: 'fedcba9876543210fedcba9876543210',
            deviceName: 'Phone',
            deviceType: 'phone',
        },
    }).serialize();
}


/**
 * Build a minimal multiplexer mock that records handshake order.
 *
 * @returns {object} A mock Bluetooth multiplexer
 */
function getMockMultiplexer() {
    const calls = [];
    const defaultChannel = {
        readLine() {
            calls.push('read');
            return Promise.resolve(getRemoteIdentity());
        },
        write() {
            calls.push('write');
            return Promise.resolve();
        },
    };

    return {
        calls,
        defaultChannel,
        close() {
            calls.push('close');
        },
    };
}


describe('Bluetooth address helpers', function () {
    it('encodes and decodes UUIDs', function () {
        const uuid = '185f3df4-3268-4e3f-9fca-d4d5059915bd';
        const bytes = Bluetooth._uuidToBytes(uuid);

        expect(bytes).toHaveSize(16);
        expect(Bluetooth._bytesToUuid(bytes)).toBe(uuid);
    });

    it('encodes and decodes unsigned 16-bit integers', function () {
        const bytes = Bluetooth._uint16(4096);

        expect(bytes).toEqual([0x10, 0x00]);
        expect(Bluetooth._readUint16(bytes, 0)).toBe(4096);
    });

    it('accepts unpacked and variant D-Bus values', function () {
        const variant = GLib.Variant.new_string('CC:F9:F0:36:00:DF');

        expect(Bluetooth._unpackVariant('bluetooth')).toBe('bluetooth');
        expect(Bluetooth._unpackVariant(variant)).toBe('CC:F9:F0:36:00:DF');
    });
});


describe('Bluetooth certificates', function () {
    it('normalizes bare PEM bodies', function () {
        expect(Bluetooth._normalizeCertificatePem('abc123'))
            .toBe('-----BEGIN CERTIFICATE-----\nabc123\n-----END CERTIFICATE-----\n');
    });

    it('preserves wrapped PEM certificates', function () {
        const pem = '-----BEGIN CERTIFICATE-----\nabc123\n-----END CERTIFICATE-----\n';

        expect(Bluetooth._normalizeCertificatePem(pem)).toBe(pem);
    });
});


describe('A Bluetooth multiplexer', function () {
    it('uses a smaller read window for control packets', async function () {
        const writes = [];
        const connection = {
            input_stream: {
                read_bytes_async() {
                    return new Promise(() => {});
                },
            },
            output_stream: {
                write_all_async(data) {
                    writes.push(data);
                    return Promise.resolve([true, data.length]);
                },
            },
            close_async() {},
        };
        const multiplexer = new Bluetooth._testInternals.ConnectionMultiplexer(
            connection, new Gio.Cancellable());

        await new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));

        const readFrame = writes.find(data => data[0] === 3);

        expect(Bluetooth._readUint16(readFrame, 19)).toBe(1024);
        multiplexer.close();
    });

    it('caps payload write frames to the Bluetooth buffer size', async function () {
        const writes = [];
        const connection = {
            input_stream: {
                read_bytes_async() {
                    return new Promise(() => {});
                },
            },
            output_stream: {
                write_all_async(data) {
                    writes.push(data);
                    return Promise.resolve([true, data.length]);
                },
            },
            close_async() {},
        };
        const multiplexer = new Bluetooth._testInternals.ConnectionMultiplexer(
            connection, new Gio.Cancellable());
        const uuid = multiplexer.newChannel();
        const channel = multiplexer.getChannel(uuid);
        const payload = new Uint8Array(5000);

        writes.splice(0);
        channel.freeWriteAmount = 5000;
        channel._appendWrite(payload);

        await new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));

        const writeFrame = writes.find(data => data[0] === 4);

        expect(Bluetooth._readUint16(writeFrame, 1)).toBe(4096);
        multiplexer.close();
    });
});


describe('A Bluetooth channel service', function () {
    let service;

    beforeEach(function () {
        const certificate = Gio.TlsCertificate.new_from_files(
            getDataPath('local-certificate.pem'),
            getDataPath('local-private.pem')
        );

        service = new Bluetooth.ChannelService({
            certificate,
            id: '0123456789abcdef0123456789abcdef',
            name: 'GSConnect',
        });
    });

    afterEach(function () {
        service.destroy();
        service = null;
    });

    it('adds Bluetooth metadata to its identity packet', function () {
        service.buildIdentity();

        expect(service.identity.body.bluetoothHost).toBe('bluetooth');
    });

    it('can add the local certificate to an identity packet', function () {
        const identity = service._identityWithCertificate();

        expect(identity.body.certificate)
            .toContain('-----BEGIN CERTIFICATE-----');
        expect(identity.body.deviceId).toBe(service.id);
    });

    it('starts asynchronously when enabled', function () {
        spyOn(service, '_start').and.returnValue(Promise.resolve());

        service.start();

        expect(service._start).toHaveBeenCalled();
    });

    it('ignores broadcast while inactive', function () {
        spyOn(service, '_loadDevices');

        service.broadcast();

        expect(service._loadDevices).not.toHaveBeenCalled();
    });

    it('discovers without opening an outgoing profile connection', function () {
        service._active = true;
        service._objects.set('CC:F9:F0:36:00:DF', '/org/bluez/hci0/dev_CC_F9_F0_36_00_DF');
        spyOn(service, '_loadDevices').and.returnValue(Promise.resolve());
        spyOn(service, '_connectDevice');

        service.broadcast('CC:F9:F0:36:00:DF');

        expect(service._loadDevices).toHaveBeenCalled();
        expect(service._connectDevice).not.toHaveBeenCalled();
    });
});


describe('A Bluetooth channel', function () {
    let backend;

    beforeEach(function () {
        backend = {
            channels: new Map(),
            identity: new Core.Packet({
                type: 'kdeconnect.identity',
                body: {
                    deviceId: '0123456789abcdef0123456789abcdef',
                    deviceName: 'GSConnect',
                    deviceType: 'desktop',
                },
            }),
            _identityWithCertificate() {
                return new Core.Packet(this.identity);
            },
            _onChannelClosed() {},
        };
    });

    afterEach(function () {
        backend = null;
    });

    it('sends identity first for incoming connections', async function () {
        const multiplexer = getMockMultiplexer();
        const channel = new Bluetooth.Channel({
            backend,
            address: 'CC:F9:F0:36:00:DF',
            multiplexer,
        });

        await channel.open();

        expect(multiplexer.calls).toEqual(['write', 'read']);
        expect(channel.identity.body.deviceName).toBe('Phone');
    });

    it('reads identity first for outgoing connections', async function () {
        const multiplexer = getMockMultiplexer();
        const channel = new Bluetooth.Channel({
            backend,
            address: 'CC:F9:F0:36:00:DF',
            initiated: true,
            multiplexer,
        });

        await channel.open();

        expect(multiplexer.calls).toEqual(['read', 'write']);
        expect(channel.identity.body.deviceName).toBe('Phone');
    });
});
