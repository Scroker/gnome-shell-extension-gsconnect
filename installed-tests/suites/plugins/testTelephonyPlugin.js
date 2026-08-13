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
    ringingCancel: {
        type: 'kdeconnect.telephony',
        body: {
            isCancel: true,
            contactName: 'Name',
            phoneNumber: '555-555-5555',
            event: 'ringing',
        },
    },
    talking: {
        type: 'kdeconnect.telephony',
        body: {
            contactName: 'Name',
            phoneNumber: '555-555-5555',
            event: 'talking',
        },
    },
    talkingCancel: {
        type: 'kdeconnect.telephony',
        body: {
            isCancel: true,
            contactName: 'Name',
            phoneNumber: '555-555-5555',
            event: 'ringing',
        },
    },
    busyCancel: {
        type: 'kdeconnect.telephony',
        body: {
            isCancel: true,
            contactName: 'Name',
            phoneNumber: '555-555-5555',
            event: 'missedCall',
        },
    },
};


describe('The telephony plugin', function () {
    let testRig;
    let localPlugin, localCallsPlugin, remotePlugin;

    beforeAll(async function () {
        await Utils.mockComponents();

        testRig = new Utils.TestRig();
        await testRig.prepare({
            localDevice: {
                incomingCapabilities: [
                    'kdeconnect.share.request',
                    'kdeconnect.telephony.request',
                    'kdeconnect.telephony.request_mute',
                ],
                outgoingCapabilities: [
                    'kdeconnect.telephony',
                ],
            },
            remoteDevice: {
                incomingCapabilities: [
                    'kdeconnect.share.request',
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
    });

    afterEach(function () {
        localCallsPlugin?._clearCallWatch();
        localPlugin?.device.settings.set_string('bluetooth-address', '');
        localPlugin?.device.settings.set_string('last-connection',
            'tcp://127.0.0.1');
    });

    it('can be loaded', async function () {
        await testRig.loadPlugins();

        localPlugin = testRig.localDevice._plugins.get('telephony');
        localCallsPlugin = testRig.localDevice._plugins.get('calls');
        remotePlugin = testRig.remoteDevice._plugins.get('telephony');

        expect(localPlugin).toBeDefined();
        expect(localCallsPlugin).toBeDefined();
        expect(remotePlugin).toBeDefined();

        // Unset the event triggers for initial tests
        localPlugin.settings.set_string('ringing-volume', 'nothing');
        localPlugin.settings.set_boolean('ringing-pause', false);

        localPlugin.settings.set_string('talking-volume', 'nothing');
        localPlugin.settings.set_boolean('talking-microphone', false);
        localPlugin.settings.set_boolean('talking-pause', false);
    });

    it('enables its GActions when connected', function () {
        testRig.setConnected(true);

        expect(localPlugin.device.get_action_enabled('muteCall')).toBeTrue();
    });

    it('shows a notification when the phone is ringing', async function () {
        remotePlugin.device.sendPacket(Packets.ringing);
        await localPlugin.awaitPacket('kdeconnect.telephony',
            Packets.ringing.body);

        expect(localPlugin.device.showNotification).toHaveBeenCalled();
    });

    it('adds Bluetooth call controls to ringing notifications', async function () {
        localPlugin.device.settings.set_string(
            'last-connection',
            'bluetooth://00:11:22:33:44:55'
        );

        remotePlugin.device.sendPacket(Packets.ringing);
        await localPlugin.awaitPacket('kdeconnect.telephony',
            Packets.ringing.body);

        const notification = localPlugin.device.showNotification
            .calls.mostRecent().args[0];

        expect(notification.action.name).toBe('showIncomingCall');
        expect(notification.action.parameter.deepUnpack()).toBe('555-555-5555');
        expect(notification.buttons.map(button => button.action)).toEqual([
            'answerCall',
            'muteCall',
            'hangupCall',
        ]);
    });

    it('can answer and hang up Bluetooth calls', async function () {
        const window = {
            showCall: jasmine.createSpy('showCall'),
            call_path: '',
        };

        spyOn(localCallsPlugin, '_ensureWindow').and.returnValue(window);
        spyOn(localCallsPlugin._bluetoothTelephony, 'answerIncomingCall')
            .and.callThrough();
        spyOn(localCallsPlugin._bluetoothTelephony, 'hangupCall')
            .and.callThrough();

        await localCallsPlugin.answerCall('555-555-5555');
        await localCallsPlugin.hangupCall('555-555-5555');

        expect(localCallsPlugin._bluetoothTelephony.answerIncomingCall)
            .toHaveBeenCalledWith(localCallsPlugin.device, '555-555-5555',
                null);
        expect(localCallsPlugin._bluetoothTelephony.hangupCall)
            .toHaveBeenCalledWith(localCallsPlugin.device, '555-555-5555',
                null);
        expect(window.showCall).toHaveBeenCalledWith(
            '555-555-5555', 'talking', null, 'close');
    });

    it('opens incoming call controls from ringing notifications', function () {
        const window = {
            showCall: jasmine.createSpy('showCall'),
        };

        spyOn(localCallsPlugin, '_ensureWindow').and.returnValue(window);

        localCallsPlugin.showIncomingCall('555-555-5555');

        expect(window.showCall).toHaveBeenCalledWith(
            '555-555-5555', 'incoming', null, 'close');
    });

    it('can place outgoing calls', async function () {
        localCallsPlugin.device.settings.set_string(
            'bluetooth-address',
            '00:11:22:33:44:55'
        );
        spyOn(localCallsPlugin._bluetoothTelephony, 'dialCall').and.callThrough();
        spyOn(localCallsPlugin, '_watchBluetoothCall');

        const callPath = await localCallsPlugin._dial('555-555-5555');

        expect(callPath).toBe('/mock/call');
        expect(localCallsPlugin._bluetoothTelephony.dialCall)
            .toHaveBeenCalledWith(localCallsPlugin.device, '555-555-5555');
        expect(localCallsPlugin._watchBluetoothCall)
            .toHaveBeenCalledWith('555-555-5555', '/mock/call');
    });

    it('can place outgoing calls from tel URIs', async function () {
        localCallsPlugin.device.settings.set_string(
            'bluetooth-address',
            '00:11:22:33:44:55'
        );
        spyOn(localCallsPlugin._bluetoothTelephony, 'dialCall').and.callThrough();
        spyOn(localCallsPlugin, '_watchBluetoothCall');

        const callPath = await localCallsPlugin._dial('tel:555-555-5555');

        expect(callPath).toBe('/mock/call');
        expect(localCallsPlugin._bluetoothTelephony.dialCall)
            .toHaveBeenCalledWith(localCallsPlugin.device, '555-555-5555');
        expect(localCallsPlugin._watchBluetoothCall)
            .toHaveBeenCalledWith('555-555-5555', '/mock/call');
    });

    it('shows an error when Bluetooth calls are unavailable', async function () {
        localCallsPlugin.device.settings.set_string(
            'bluetooth-address',
            '00:11:22:33:44:55'
        );
        spyOn(remotePlugin.device, 'handlePacket').and.callThrough();
        spyOn(localCallsPlugin._bluetoothTelephony, 'dialCall')
            .and.returnValue(Promise.resolve(false));

        const result = await localCallsPlugin._dial('tel:555-555-5555');

        expect(result).toEqual(jasmine.objectContaining({
            error: 'bluetooth-call-unavailable',
        }));
        expect(remotePlugin.device.handlePacket).not.toHaveBeenCalledWith(
            jasmine.objectContaining({type: 'kdeconnect.share.request'})
        );
    });

    it('requires a saved Bluetooth address for outgoing HFP calls', async function () {
        spyOn(localCallsPlugin._bluetoothTelephony, 'dialCall').and.callThrough();
        spyOn(remotePlugin.device, 'handlePacket').and.callThrough();

        const result = await localCallsPlugin._dial('tel:555-555-5555');

        expect(result).toEqual(jasmine.objectContaining({
            error: 'bluetooth-association-required',
        }));
        expect(localCallsPlugin._bluetoothTelephony.dialCall)
            .not.toHaveBeenCalled();
        expect(remotePlugin.device.handlePacket).not.toHaveBeenCalledWith(
            jasmine.objectContaining({type: 'kdeconnect.share.request'})
        );
    });

    it('finishes the call window when an outgoing Bluetooth call ends', function () {
        localCallsPlugin._window = {
            finishCall: jasmine.createSpy('finishCall'),
        };

        localCallsPlugin._finishBluetoothCall();

        expect(localCallsPlugin._window.finishCall).toHaveBeenCalled();

        localCallsPlugin._window = null;
    });

    it('hides the notification if the phone stops ringing', async function () {
        remotePlugin.device.sendPacket(Packets.ringingCancel);
        await localPlugin.awaitPacket('kdeconnect.telephony',
            Packets.ringingCancel.body);

        expect(localPlugin.device.hideNotification).toHaveBeenCalled();
    });

    it('shows a notification when the phone is answered', async function () {
        remotePlugin.device.sendPacket(Packets.talking);
        await localPlugin.awaitPacket('kdeconnect.telephony',
            Packets.talking.body);

        expect(localPlugin.device.showNotification).toHaveBeenCalled();
    });

    it('hides the notification when the call ends', async function () {
        remotePlugin.device.sendPacket(Packets.talkingCancel);
        await localPlugin.awaitPacket('kdeconnect.telephony',
            Packets.talkingCancel.body);

        expect(localPlugin.device.hideNotification).toHaveBeenCalled();
    });

    it('leaves call windows to the calls plugin', async function () {
        localCallsPlugin._window = {
            finishCall: jasmine.createSpy('finishCall'),
        };

        remotePlugin.device.sendPacket(Packets.busyCancel);
        await localPlugin.awaitPacket('kdeconnect.telephony',
            Packets.busyCancel.body);

        expect(localCallsPlugin._window.finishCall).not.toHaveBeenCalled();

        localCallsPlugin._window = null;
    });

    describe('can lower and restore the volume', function () {
        let localMixer;

        beforeEach(function () {
            localPlugin.device.settings.set_string(
                'last-connection',
                'tcp://127.0.0.1'
            );
            localMixer = localPlugin._mixer;
            spyOn(localMixer, 'lowerVolume');
            spyOn(localMixer, 'restore');
        });

        it('when the phone is ringing', async function () {
            localPlugin.settings.set_string('ringing-volume', 'lower');

            remotePlugin.device.sendPacket(Packets.ringing);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.ringing.body);

            expect(localMixer.lowerVolume).toHaveBeenCalled();

            remotePlugin.device.sendPacket(Packets.ringingCancel);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.ringingCancel.body);

            expect(localMixer.restore).toHaveBeenCalled();
        });

        it('when the phone is answered', async function () {
            localPlugin.settings.set_string('talking-volume', 'lower');

            // Start
            remotePlugin.device.sendPacket(Packets.talking);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talking.body);

            expect(localMixer.lowerVolume).toHaveBeenCalled();

            // End
            remotePlugin.device.sendPacket(Packets.talkingCancel);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talkingCancel.body);

            expect(localMixer.restore).toHaveBeenCalled();
        });
    });

    describe('can mute and unmute the volume', function () {
        let localMixer;

        beforeEach(function () {
            localPlugin.device.settings.set_string(
                'last-connection',
                'tcp://127.0.0.1'
            );
            localMixer = localPlugin._mixer;
            spyOn(localMixer, 'muteVolume');
            spyOn(localMixer, 'restore');
        });

        it('when the phone is ringing', async function () {
            localPlugin.settings.set_string('ringing-volume', 'mute');

            remotePlugin.device.sendPacket(Packets.ringing);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.ringing.body);

            expect(localMixer.muteVolume).toHaveBeenCalled();

            remotePlugin.device.sendPacket(Packets.ringingCancel);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.ringingCancel.body);

            expect(localMixer.restore).toHaveBeenCalled();
        });

        it('when the phone is answered', async function () {
            localPlugin.settings.set_string('talking-volume', 'mute');

            // Start
            remotePlugin.device.sendPacket(Packets.talking);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talking.body);

            expect(localMixer.muteVolume).toHaveBeenCalled();

            // End
            remotePlugin.device.sendPacket(Packets.talkingCancel);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talkingCancel.body);

            expect(localMixer.restore).toHaveBeenCalled();
        });
    });

    describe('can mute and unmute the microphone', function () {
        let localMixer;

        beforeEach(function () {
            localPlugin.device.settings.set_string(
                'last-connection',
                'tcp://127.0.0.1'
            );
            localMixer = localPlugin._mixer;
            spyOn(localMixer, 'muteMicrophone');
            spyOn(localMixer, 'restore');
        });

        it('when the phone is answered', async function () {
            localPlugin.settings.set_boolean('talking-microphone', true);

            // Start
            remotePlugin.device.sendPacket(Packets.talking);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talking.body);

            expect(localMixer.muteMicrophone).toHaveBeenCalled();

            // End
            remotePlugin.device.sendPacket(Packets.talkingCancel);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talkingCancel.body);

            expect(localMixer.restore).toHaveBeenCalled();
        });
    });

    describe('uses application audio controls for Bluetooth calls', function () {
        let localMixer;

        beforeEach(function () {
            localPlugin.device.settings.set_string(
                'last-connection',
                'tcp://127.0.0.1'
            );
            localPlugin.device.settings.set_string(
                'bluetooth-address',
                '00:11:22:33:44:55'
            );
            localPlugin.settings.set_string('talking-volume', 'nothing');
            localPlugin.settings.set_boolean('talking-microphone', false);
            localMixer = localPlugin._mixer;
            spyOn(localMixer, 'lowerApplicationVolumes');
            spyOn(localMixer, 'muteApplicationVolumes');
            spyOn(localMixer, 'muteApplicationMicrophones');
            spyOn(localMixer, 'lowerVolume');
            spyOn(localMixer, 'muteVolume');
            spyOn(localMixer, 'muteMicrophone');
        });

        it('when lowering volume while ringing', async function () {
            localPlugin.settings.set_string('ringing-volume', 'lower');

            remotePlugin.device.sendPacket(Packets.ringing);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.ringing.body);

            expect(localMixer.lowerApplicationVolumes).toHaveBeenCalled();
            expect(localMixer.lowerVolume).not.toHaveBeenCalled();
        });

        it('when muting volume while ringing', async function () {
            localPlugin.settings.set_string('ringing-volume', 'mute');

            remotePlugin.device.sendPacket(Packets.ringing);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.ringing.body);

            expect(localMixer.muteApplicationVolumes).toHaveBeenCalled();
            expect(localMixer.muteVolume).not.toHaveBeenCalled();
        });

        it('when lowering volume during a call', async function () {
            localPlugin.settings.set_string('talking-volume', 'lower');

            remotePlugin.device.sendPacket(Packets.talking);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talking.body);

            expect(localMixer.lowerApplicationVolumes).toHaveBeenCalled();
            expect(localMixer.lowerVolume).not.toHaveBeenCalled();
        });

        it('when muting volume during a call', async function () {
            localPlugin.settings.set_string('talking-volume', 'mute');

            remotePlugin.device.sendPacket(Packets.talking);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talking.body);

            expect(localMixer.muteApplicationVolumes).toHaveBeenCalled();
            expect(localMixer.muteVolume).not.toHaveBeenCalled();
        });

        it('when muting microphones during a call', async function () {
            localPlugin.settings.set_boolean('talking-microphone', true);

            remotePlugin.device.sendPacket(Packets.talking);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talking.body);

            expect(localMixer.muteApplicationMicrophones).toHaveBeenCalled();
            expect(localMixer.muteMicrophone).not.toHaveBeenCalled();
        });
    });

    describe('can pause and unpause media', function () {
        let localMedia;

        beforeEach(function () {
            localMedia = localPlugin._mpris;
            spyOn(localMedia, 'pauseAll');
            spyOn(localMedia, 'unpauseAll');
        });

        it('when the phone is ringing', async function () {
            localPlugin.settings.set_boolean('ringing-pause', true);

            remotePlugin.device.sendPacket(Packets.ringing);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.ringing.body);

            expect(localMedia.pauseAll).toHaveBeenCalled();

            remotePlugin.device.sendPacket(Packets.ringingCancel);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.ringingCancel.body);

            expect(localMedia.unpauseAll).toHaveBeenCalled();
        });

        it('when the phone is answered', async function () {
            localPlugin.settings.set_boolean('talking-pause', true);

            // Start
            remotePlugin.device.sendPacket(Packets.talking);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talking.body);

            expect(localMedia.pauseAll).toHaveBeenCalled();

            // End
            remotePlugin.device.sendPacket(Packets.talkingCancel);
            await localPlugin.awaitPacket('kdeconnect.telephony',
                Packets.talkingCancel.body);

            expect(localMedia.unpauseAll).toHaveBeenCalled();
        });
    });

    it('disabled its GActions when disconnected', function () {
        testRig.setConnected(false);

        expect(localPlugin.device.get_action_enabled('muteCall')).toBeFalse();
    });
});
