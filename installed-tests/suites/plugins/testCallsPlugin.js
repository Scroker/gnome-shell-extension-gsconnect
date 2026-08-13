// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import * as Utils from '../fixtures/utils.js';


const Packets = {
    ringing: {
        type: 'kdeconnect.telephony',
        body: {
            contactName: 'Name',
            phoneNumber: '555-555-5555',
            event: 'ringing',
        },
    },
};


describe('The calls plugin', function () {
    let testRig;
    let localPlugin, localTelephonyPlugin, remoteTelephonyPlugin;

    beforeAll(async function () {
        await Utils.mockComponents();

        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [
                    'kdeconnect.telephony.request',
                    'kdeconnect.telephony.request_mute',
                ],
                outgoingCapabilities: [
                    'kdeconnect.telephony',
                ],
            },
            remoteDevice: {
                incomingCapabilities: [
                    'kdeconnect.telephony.request',
                    'kdeconnect.telephony.request_mute',
                ],
                outgoingCapabilities: [
                    'kdeconnect.telephony',
                ],
            },
        });
        testRig.setPaired(true);
        testRig.setConnected(true);

        testRig.localDevice.settings.set_strv('disabled-plugins', []);
        testRig.remoteDevice.settings.set_strv('disabled-plugins', []);
    });

    afterAll(function () {
        testRig.destroy();
    });

    beforeEach(function () {
        if (localPlugin) {
            spyOn(localPlugin, 'handlePacket').and.callThrough();
            spyOn(localPlugin.device, 'showNotification');
            spyOn(localPlugin.device, 'hideNotification');
        }

        if (localTelephonyPlugin)
            spyOn(localTelephonyPlugin, 'handlePacket').and.callThrough();
    });

    afterEach(function () {
        localPlugin?._clearCallWatch();

        if (localPlugin?._bluetoothTelephony !== undefined)
            localPlugin._bluetoothTelephony.call_info = null;
        if (localPlugin?._bluetoothTelephony !== undefined)
            localPlugin._bluetoothTelephony.active_call = true;
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('calls');
        localTelephonyPlugin = testRig.localDevice._plugins.get('telephony');
        remoteTelephonyPlugin = testRig.remoteDevice._plugins.get('telephony');

        expect(localPlugin).toBeDefined();
        expect(localTelephonyPlugin).toBeDefined();
        expect(remoteTelephonyPlugin).toBeDefined();
    });

    it('handles telephony notifications when active', async function () {
        remoteTelephonyPlugin.device.sendPacket(Packets.ringing);
        await localPlugin.awaitPacket('kdeconnect.telephony',
            Packets.ringing.body);

        expect(localPlugin.handlePacket).toHaveBeenCalled();
        expect(localTelephonyPlugin.handlePacket).not.toHaveBeenCalled();
        expect(localPlugin.device.showNotification).toHaveBeenCalled();

        const notification = localPlugin.device.showNotification
            .calls.mostRecent().args[0];

        expect(notification.action.name).toBe('showIncomingCall');
        expect(notification.buttons.map(button => button.action)).toEqual([
            'answerCall',
            'muteIncomingCall',
            'hangupCall',
        ]);
    });

    it('shows incoming HFP calls from Bluetooth call state', async function () {
        localPlugin._bluetoothTelephony.call_info = {
            path: '/mock/call',
            state: 'incoming',
            phoneNumber: '555-555-5555',
            name: 'Name',
        };

        await localPlugin._syncBluetoothCallNotification();

        expect(localPlugin.device.showNotification).toHaveBeenCalled();

        const notification = localPlugin.device.showNotification
            .calls.mostRecent().args[0];

        expect(notification.title).toBe('Name');
        expect(notification.body).toBe('Incoming call');
        expect(notification.buttons.map(button => button.action)).toEqual([
            'answerCall',
            'hangupCall',
        ]);
    });

    it('finishes the call window when an incoming HFP call ends', async function () {
        localPlugin._bluetoothTelephony.call_info = {
            path: '/mock/call',
            state: 'incoming',
            phoneNumber: '555-555-5555',
            name: 'Name',
        };

        await localPlugin._syncBluetoothCallNotification();

        localPlugin._window = {
            finishCall: jasmine.createSpy('finishCall'),
        };
        localPlugin._bluetoothTelephony.call_info = null;
        localPlugin._bluetoothTelephony.active_call = false;

        await localPlugin._syncBluetoothCallNotification();

        expect(localPlugin.device.hideNotification)
            .toHaveBeenCalledWith('ringing|Name');
        expect(localPlugin._window.finishCall).toHaveBeenCalled();

        localPlugin._window = null;
    });
});
