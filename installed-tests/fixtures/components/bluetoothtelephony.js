// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GObject from 'gi://GObject';


const MockBluetoothTelephony = GObject.registerClass({
    GTypeName: 'GSConnectMockBluetoothTelephony',
    Signals: {
        'calls-changed': {
            flags: GObject.SignalFlags.RUN_FIRST,
        },
    },
}, class MockBluetoothTelephony extends GObject.Object {

    _init() {
        super._init();

        this.call_info = null;
    }

    canControl(device) {
        return device.connection_type === 'bluetooth';
    }

    hasBluetoothAddress(device) {
        return device.settings.get_string('last-connection')
            .startsWith('bluetooth://') ||
            device.settings.get_string('bluetooth-address') !== '';
    }

    answerIncomingCall() {
        return Promise.resolve(true);
    }

    hangupCall() {
        return Promise.resolve(true);
    }

    dialCall() {
        return Promise.resolve('/mock/call');
    }

    hasActiveCall() {
        return Promise.resolve(true);
    }

    findCallInfo() {
        return Promise.resolve(this.call_info);
    }

    destroy() {}
});

export default MockBluetoothTelephony;
