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
        if (localPlugin)
            localPlugin._currentCall = null;
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
        expect(notification.id).toBe('ringing|/mock/call');
        expect(notification.buttons.map(button => button.action)).toEqual([
            'answerCall',
            'hangupCall',
        ]);
    });

    it('enriches HFP ringing notifications from delayed Telephony events', async function () {
        localPlugin._bluetoothTelephony.call_info = {
            path: '/mock/call',
            state: 'incoming',
            phoneNumber: '555-555-5555',
            name: '',
        };

        await localPlugin._syncBluetoothCallNotification();
        localPlugin.device.showNotification.calls.reset();

        remoteTelephonyPlugin.device.sendPacket(Packets.ringing);
        await localPlugin.awaitPacket('kdeconnect.telephony',
            Packets.ringing.body);

        expect(localPlugin.device.showNotification).toHaveBeenCalled();

        const notification = localPlugin.device.showNotification
            .calls.mostRecent().args[0];

        expect(notification.id).toBe('ringing|/mock/call');
        expect(notification.title).toBe('Name');
        expect(notification.buttons.map(button => button.action)).toEqual([
            'answerCall',
            'hangupCall',
        ]);
    });

    it('does not reapply media state for repeated HFP ringing syncs', async function () {
        const localMixer = localPlugin._mixer;

        spyOn(localMixer, 'lowerApplicationVolumes');
        localTelephonyPlugin.settings.set_string('ringing-volume', 'lower');
        localPlugin._bluetoothTelephony.call_info = {
            path: '/mock/call',
            state: 'incoming',
            phoneNumber: '555-555-5555',
            name: 'Name',
        };

        await localPlugin._syncBluetoothCallNotification();
        await localPlugin._syncBluetoothCallNotification();

        expect(localMixer.lowerApplicationVolumes).toHaveBeenCalledTimes(1);
    });

    it('uses application audio controls for HFP calls', function () {
        const localMixer = localPlugin._mixer;

        spyOn(localMixer, 'lowerApplicationVolumes');
        spyOn(localMixer, 'muteApplicationVolumes');
        spyOn(localMixer, 'muteApplicationMicrophones');
        spyOn(localMixer, 'lowerVolume');
        spyOn(localMixer, 'muteVolume');
        spyOn(localMixer, 'muteMicrophone');

        localTelephonyPlugin.settings.set_string('ringing-volume', 'lower');
        localPlugin._setMediaState('ringing', true);

        expect(localMixer.lowerApplicationVolumes).toHaveBeenCalled();
        expect(localMixer.lowerVolume).not.toHaveBeenCalled();

        localTelephonyPlugin.settings.set_string('talking-volume', 'mute');
        localTelephonyPlugin.settings.set_boolean('talking-microphone', true);
        localPlugin._setMediaState('talking', true);

        expect(localMixer.muteApplicationVolumes).toHaveBeenCalled();
        expect(localMixer.muteApplicationMicrophones).toHaveBeenCalled();
        expect(localMixer.muteVolume).not.toHaveBeenCalled();
        expect(localMixer.muteMicrophone).not.toHaveBeenCalled();
    });

    it('uses Telephony settings when the Telephony plugin is unavailable', function () {
        const localMixer = localPlugin._mixer;
        const telephonyPlugin = localPlugin.device._plugins.get('telephony');

        spyOn(localMixer, 'lowerApplicationVolumes');
        spyOn(localMixer, 'lowerVolume');

        localPlugin._telephonySettings = null;
        localPlugin.device._plugins.delete('telephony');

        try {
            localPlugin.telephony_settings.set_string('ringing-volume', 'lower');
            localPlugin._setMediaState('ringing', true);
        } finally {
            localPlugin.device._plugins.set('telephony', telephonyPlugin);
        }

        expect(localMixer.lowerApplicationVolumes).toHaveBeenCalled();
        expect(localMixer.lowerVolume).not.toHaveBeenCalled();
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
            .toHaveBeenCalledWith('ringing|/mock/call');
        expect(localPlugin._window.finishCall).toHaveBeenCalled();

        localPlugin._window = null;
    });
});
