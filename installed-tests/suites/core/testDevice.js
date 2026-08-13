// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';

import * as Utils from '../fixtures/utils.js';

import Config from '../config.js';
const {
    default: Device,
    _isPointerMousepadRequest,
} = await import(`file://${Config.PACKAGE_DATADIR}/service/device.js`);


describe('A mousepad request', function () {
    it('identifies pointer motion packets', function () {
        expect(_isPointerMousepadRequest({
            type: 'kdeconnect.mousepad.request',
            body: {dx: 1, dy: -1},
        })).toBeTrue();

        expect(_isPointerMousepadRequest({
            type: 'kdeconnect.mousepad.request',
            body: {singleclick: true},
        })).toBeFalse();

        expect(_isPointerMousepadRequest({
            type: 'kdeconnect.ping',
            body: {dx: 1, dy: -1},
        })).toBeFalse();
    });
});


describe('A device constructed from a packet', function () {
    let device, identity;

    beforeAll(function () {
        identity = Utils.generateIdentity({
            body: {
                incomingCapabilities: ['kdeconnect.ping'],
                outgoingCapabilities: ['kdeconnect.ping'],
            },
        });
        device = new Device(identity);
    });

    afterAll(function () {
        device.destroy();
    });

    it('initializes properties', function () {
        expect(device.id).toBe(identity.body.deviceId);
        expect(device.name).toBe(identity.body.deviceName);
        expect(device.type).toBe(identity.body.deviceType);

        // expect(device.contacts).toBeTruthy();
        expect(device.encryption_info).toBe('');
        expect(device.icon_name).toBeTruthy();

        expect(device.connected).toBeFalse();
        expect(device.paired).toBeFalse();

        expect(device.settings).toBeInstanceOf(Gio.Settings);
        expect(device.menu).toBeInstanceOf(Gio.Menu);
    });

    it('will not load plugins when unpaired', async function () {
        await device._loadPlugins();
        expect(device._plugins).toHaveSize(0);
    });

    it('will load plugins when paired', async function () {
        device._setPaired(true);
        expect(device.paired).toBeTrue();

        await device._loadPlugins();
        expect(device._plugins).toHaveSize(1);
    });

    it('unloads plugins when unpaired', function () {
        device.unpair();
        expect(device.paired).toBeFalse();
        expect(device._plugins).toHaveSize(0);
    });
});


describe('A device constructed from an ID', function () {
    let device, id;

    beforeAll(function () {
        id = Device.generateId();
        device = new Device({body: {deviceId: id}});
    });

    afterAll(function () {
        device.destroy();
    });

    it('initializes properties', function () {
        expect(device.id).toBe(id);
        expect(device.name).toBe('');
        expect(device.type).toBe('smartphone');

        // expect(device.contacts).toBeTruthy();
        expect(device.encryption_info).toBe('');
        expect(device.icon_name).toBeTruthy();

        expect(device.connected).toBeFalse();
        expect(device.paired).toBeFalse();

        expect(device.settings).toBeInstanceOf(Gio.Settings);
        expect(device.menu).toBeInstanceOf(Gio.Menu);
    });

    it('will not load plugins when unpaired', function () {
        device._loadPlugins();
        expect(device._plugins).toHaveSize(0);
    });

    it('will load plugins when paired', function () {
        device._setPaired(true);
        expect(device.paired).toBeTrue();

        device._loadPlugins();
        expect(device._plugins).toHaveSize(0);
    });

    it('will unload plugins when unpaired', function () {
        device.unpair();
        expect(device.paired).toBeFalse();
        expect(device._plugins).toHaveSize(0);
    });
});


describe('A Bluetooth device', function () {
    let device, packets;

    beforeEach(function () {
        const identity = Utils.generateIdentity({
            body: {
                incomingCapabilities: ['kdeconnect.mousepad.request'],
                outgoingCapabilities: ['kdeconnect.mousepad.request'],
            },
        });

        packets = [];
        device = new Device(identity);
        device.settings.set_boolean('paired', true);
        device.settings.set_string('last-connection', 'bluetooth://00:11:22:33:44:55');
        device._connected = true;
        device._channel = {
            close() {},
            sendPacket(packet) {
                packets.push(packet);
            },
        };
    });

    afterEach(function () {
        device.destroy();
    });

    it('throttles outgoing pointer motion over Bluetooth', async function () {
        spyOn(Date, 'now').and.returnValues(1000, 1005, 1005);

        await device.sendPacket({
            type: 'kdeconnect.mousepad.request',
            body: {dx: 1, dy: -1},
        });
        await device.sendPacket({
            type: 'kdeconnect.mousepad.request',
            body: {dx: 2, dy: -2},
        });
        await device.sendPacket({
            type: 'kdeconnect.mousepad.request',
            body: {singleclick: true},
        });

        expect(packets).toHaveSize(2);
        expect(packets[0].body.dx).toBe(1);
        expect(packets[1].body.singleclick).toBeTrue();
    });
});
