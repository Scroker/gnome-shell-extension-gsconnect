// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

export default class MockBluetoothTelephony {

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

    destroy() {}
}
