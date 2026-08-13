// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';

import * as Components from '../components/index.js';
import * as Contacts from '../ui/contacts.js';
import Plugin from '../plugin.js';


/**
 * Return the dialable phone number from a phone number or tel: URI.
 *
 * @param {string} uri - A phone number or tel: URI
 * @returns {string} The dialable phone number
 */
function _dialNumberFromUri(uri) {
    if (!uri?.startsWith('tel:'))
        return uri;

    let number = uri.replace(/^tel:(?:\/\/\/)?/, '');
    const separator = number.search(/[;?]/);

    if (separator !== -1)
        number = number.slice(0, separator);

    return decodeURIComponent(number);
}

/**
 * Return the UI error shown when a device has not been associated with its
 * Bluetooth Hands-Free gateway yet.
 *
 * @returns {object} The UI error details
 */
function _bluetoothAssociationRequired() {
    return {
        error: 'bluetooth-association-required',
        // TRANSLATORS: The phone has not been associated with its Bluetooth
        // Hands-Free gateway yet
        title: _('Bluetooth Association Required'),
        message: _('Connect this device once with GSConnect\'s experimental Bluetooth backend to place calls from the PC.'),
    };
}

/**
 * Return the UI error shown when the associated Bluetooth Hands-Free gateway
 * cannot place a call.
 *
 * @returns {object} The UI error details
 */
function _bluetoothCallUnavailable() {
    return {
        error: 'bluetooth-call-unavailable',
        // TRANSLATORS: The Bluetooth Hands-Free gateway is unavailable
        title: _('Bluetooth Call Unavailable'),
        message: _('The phone is paired with GSConnect, but the Bluetooth call profile is not available. Disconnect and reconnect the phone over Bluetooth, or restart Bluetooth on the PC.'),
    };
}


export const Metadata = {
    label: _('Calls'),
    description: _('Place and control Bluetooth calls from the PC'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Calls',
    incomingCapabilities: [
        'kdeconnect.telephony',
    ],
    outgoingCapabilities: [],
    actions: {
        call: {
            // TRANSLATORS: Place an outgoing call from the paired phone
            label: _('Call'),
            icon_name: 'call-start-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: [],
        },
        uriCall: {
            // TRANSLATORS: Place an outgoing call from a tel: URI
            label: _('Call Number'),
            icon_name: 'call-start-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: [],
        },
        answerCall: {
            // TRANSLATORS: Answer the actively ringing call
            label: _('Answer Call'),
            icon_name: 'call-start-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: [],
        },
        showIncomingCall: {
            // TRANSLATORS: Show the incoming call controls
            label: _('Show Incoming Call'),
            icon_name: 'call-start-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: [],
        },
        hangupCall: {
            // TRANSLATORS: Decline or hang up the active call
            label: _('Hang Up'),
            icon_name: 'call-stop-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: [],
        },
        muteIncomingCall: {
            // TRANSLATORS: Silence the actively ringing call
            label: _('Mute Call'),
            icon_name: 'audio-volume-muted-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.telephony'],
            outgoing: ['kdeconnect.telephony.request_mute'],
        },
    },
};


/**
 * Bluetooth Calls Plugin
 */
const CallsPlugin = GObject.registerClass({
    GTypeName: 'GSConnectCallsPlugin',
}, class CallsPlugin extends Plugin {

    _init(device) {
        super._init(device, 'calls');

        this._bluetoothTelephony = Components.acquire('bluetoothtelephony');
        this._mixer = Components.acquire('pulseaudio');
        this._mpris = Components.acquire('mpris');
        this._window = null;
        this._callWatchId = 0;
        this._callWatchToken = 0;
        this._bluetoothCallsChangedId = 0;
        this._bluetoothCallSyncing = false;
        this._incomingSender = null;
        this._incomingCallNumber = null;
        this._incomingCallPath = null;
    }

    get telephony_settings() {
        return this.device._plugins.get('telephony')?.settings ?? null;
    }

    connected() {
        super.connected();

        if (this._bluetoothCallsChangedId === 0 &&
            this._bluetoothTelephony?.connect instanceof Function) {
            this._bluetoothCallsChangedId = this._bluetoothTelephony.connect(
                'calls-changed',
                this._syncBluetoothCallNotification.bind(this)
            );
        }

        this._syncBluetoothCallNotification();
    }

    disconnected() {
        super.disconnected();

        if (this._bluetoothCallsChangedId !== 0) {
            this._bluetoothTelephony.disconnect(this._bluetoothCallsChangedId);
            this._bluetoothCallsChangedId = 0;
        }

        this._incomingSender = null;
        this._incomingCallNumber = null;
        this._incomingCallPath = null;
    }

    handlePacket(packet) {
        if (packet.type !== 'kdeconnect.telephony')
            return;

        if (!['ringing', 'talking'].includes(packet.body.event))
            return;

        if (packet.body.isCancel) {
            this._cancelTelephonyEvent(packet);
            return;
        }

        this._handleTelephonyEvent(packet);
    }

    _getSender(packet) {
        // TRANSLATORS: No name or phone number
        let sender = _('Unknown Contact');

        if (packet.body.contactName)
            sender = packet.body.contactName;
        else if (packet.body.phoneNumber)
            sender = packet.body.phoneNumber;

        return sender;
    }

    _setMediaState(eventType, hfp = false) {
        const settings = this.telephony_settings;

        if (settings === null)
            return;

        if (this._mixer !== undefined) {
            switch (settings.get_string(`${eventType}-volume`)) {
                case 'restore':
                    this._mixer.restore();
                    break;

                case 'lower':
                    if (hfp)
                        this._mixer.lowerApplicationVolumes();
                    else
                        this._mixer.lowerVolume();
                    break;

                case 'mute':
                    if (hfp)
                        this._mixer.muteApplicationVolumes();
                    else
                        this._mixer.muteVolume();
                    break;
            }

            if (eventType === 'talking' &&
                settings.get_boolean('talking-microphone')) {
                if (hfp)
                    this._mixer.muteApplicationMicrophones();
                else
                    this._mixer.muteMicrophone();
            }
        }

        if (this._mpris && settings.get_boolean(`${eventType}-pause`))
            this._mpris.pauseAll();
    }

    _restoreMediaState() {
        if (this._mpris)
            this._mpris.unpauseAll();

        if (this._mixer)
            this._mixer.restore();
    }

    _cancelTelephonyEvent(packet) {
        this.device.hideNotification(`${packet.body.event}|${this._getSender(packet)}`);
        this._restoreMediaState();
    }

    _handleTelephonyEvent(packet) {
        const sender = this._getSender(packet);

        if (packet.body.event === 'ringing') {
            this._notifyIncomingCall({
                id: `ringing|${sender}`,
                sender,
                phoneNumber: packet.body.phoneNumber ?? '',
                hfp: false,
            });
            return;
        }

        if (packet.body.event === 'talking') {
            this.device.hideNotification(`ringing|${sender}`);
            this._setMediaState('talking');
            this.device.showNotification({
                id: `talking|${sender}`,
                title: sender,
                // TRANSLATORS: A phone call is active
                body: _('Ongoing call'),
                icon: new Gio.ThemedIcon({name: 'call-start-symbolic'}),
                priority: Gio.NotificationPriority.NORMAL,
            });
        }
    }

    _notifyIncomingCall({id, sender, phoneNumber, callPath = null, hfp = true}) {
        this._incomingSender = sender;
        this._incomingCallNumber = phoneNumber ?? '';
        this._incomingCallPath = callPath;
        this._setMediaState('ringing', hfp);

        const parameter = new GLib.Variant('s', phoneNumber ?? '');
        const buttons = [{
            action: 'answerCall',
            // TRANSLATORS: Answer the actively ringing call
            label: _('Answer'),
            parameter,
        }];

        if (!hfp) {
            buttons.push({
                action: 'muteIncomingCall',
                // TRANSLATORS: Silence the actively ringing call
                label: _('Mute'),
                parameter: null,
            });
        }

        buttons.push({
            action: 'hangupCall',
            // TRANSLATORS: Decline the actively ringing call
            label: _('Decline'),
            parameter,
        });

        this.device.showNotification({
            id,
            title: sender,
            // TRANSLATORS: The phone is ringing
            body: _('Incoming call'),
            icon: new Gio.ThemedIcon({name: 'call-start-symbolic'}),
            priority: Gio.NotificationPriority.URGENT,
            action: {
                name: 'showIncomingCall',
                parameter,
            },
            buttons,
        });
    }

    async _syncBluetoothCallNotification() {
        if (this._bluetoothCallSyncing)
            return;

        this._bluetoothCallSyncing = true;

        try {
            const call = await this._bluetoothTelephony?.findCallInfo(
                this.device,
                null,
                ['incoming', 'waiting', 'alerting']
            );

            if (call !== null && call !== undefined) {
                const sender = call.name || call.phoneNumber ||
                    _('Unknown Contact');

                this._notifyIncomingCall({
                    id: `ringing|${sender}`,
                    sender,
                    phoneNumber: call.phoneNumber,
                    callPath: call.path,
                    hfp: true,
                });
            } else if (this._incomingSender !== null) {
                this.device.hideNotification(`ringing|${this._incomingSender}`);
                const active = await this._bluetoothTelephony?.hasActiveCall(
                    this.device,
                    this._incomingCallNumber,
                    this._incomingCallPath
                );

                if (active) {
                    if (this._window !== null) {
                        this._window.showCall(
                            this._incomingCallNumber,
                            'talking',
                            this._incomingCallPath,
                            'close'
                        );
                    }

                    this._setMediaState('talking', true);
                    this._watchBluetoothCall(
                        this._incomingCallNumber,
                        this._incomingCallPath
                    );
                } else if (this._window !== null) {
                    this._window.finishCall();
                    this._restoreMediaState();
                } else {
                    this._restoreMediaState();
                }

                this._incomingSender = null;
                this._incomingCallNumber = null;
                this._incomingCallPath = null;
            }
        } catch (e) {
            debug(e, this.device.name);
        } finally {
            this._bluetoothCallSyncing = false;
        }
    }

    async _dial(number) {
        if (!number)
            return false;

        const uri = number.startsWith('tel:') ? number : `tel:${number}`;
        const dialNumber = _dialNumberFromUri(uri);

        if (this._bluetoothTelephony !== undefined) {
            if (!this._bluetoothTelephony.hasBluetoothAddress(this.device))
                return _bluetoothAssociationRequired();

            try {
                const callPath = await this._bluetoothTelephony.dialCall(
                    this.device, dialNumber);

                if (callPath) {
                    this._setMediaState('talking', true);
                    this._watchBluetoothCall(dialNumber,
                        typeof callPath === 'string' ? callPath : null);
                    return callPath;
                }
            } catch (e) {
                debug(e, this.device.name);
            }

            return _bluetoothCallUnavailable();
        }

        this._shareTelUri(uri);
        return false;
    }

    _clearCallWatch() {
        this._callWatchToken++;

        if (this._callWatchId !== 0) {
            GLib.source_remove(this._callWatchId);
            this._callWatchId = 0;
        }
    }

    _finishBluetoothCall() {
        this._clearCallWatch();
        this._restoreMediaState();

        if (this._window !== null)
            this._window.finishCall();
    }

    _watchBluetoothCall(phoneNumber, callPath = null) {
        this._clearCallWatch();

        const token = this._callWatchToken;
        let checks = 0;
        let seenCall = callPath !== null;
        let checking = false;

        this._callWatchId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            1,
            () => {
                if (checking)
                    return GLib.SOURCE_CONTINUE;

                checking = true;
                checks++;

                Promise.resolve(this._bluetoothTelephony?.hasActiveCall(
                    this.device, phoneNumber, callPath))
                    .then(active => {
                        if (token !== this._callWatchToken)
                            return;

                        if (active) {
                            seenCall = true;
                            return;
                        }

                        // PipeWire may publish outgoing calls shortly after
                        // Dial(), so leave a small grace period before deciding
                        // a call that was never observed has ended.
                        if (!seenCall && checks < 3)
                            return;

                        this._finishBluetoothCall();
                    })
                    .catch(e => debug(e, this.device.name))
                    .finally(() => {
                        checking = false;
                    });

                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _shareTelUri(uri) {
        this.device.sendPacket({
            type: 'kdeconnect.share.request',
            body: {
                url: uri,
            },
        });
    }

    /**
     * Open the call window.
     */
    call() {
        this._ensureWindow().present();
    }

    /**
     * Place an outgoing call by asking the paired device to open a tel: URI.
     *
     * @param {string} uri - A phone number or tel: URI
     */
    uriCall(uri) {
        this._dial(uri);
    }

    answerCall(phoneNumber = null, callPath = null) {
        return Promise.resolve(this._bluetoothTelephony?.answerIncomingCall(
            this.device, phoneNumber, callPath))
            .then(answeredPath => {
                if (answeredPath) {
                    const window = this._ensureWindow();
                    const path = typeof answeredPath === 'string'
                        ? answeredPath
                        : callPath;

                    this._setMediaState('talking', true);
                    window.showCall(phoneNumber, 'talking', path, 'close');
                    this._watchBluetoothCall(phoneNumber, path);
                }

                return answeredPath;
            })
            .catch(e => {
                debug(e, this.device.name);
                return false;
            });
    }

    showIncomingCall(phoneNumber = null) {
        const window = this._ensureWindow();
        window.showCall(phoneNumber, 'incoming', this._incomingCallPath, 'close');
    }

    hangupCall(phoneNumber = null, callPath = null) {
        this._clearCallWatch();
        this._restoreMediaState();

        return Promise.resolve(this._bluetoothTelephony?.hangupCall(
            this.device, phoneNumber, callPath))
            .catch(e => debug(e, this.device.name));
    }

    muteIncomingCall() {
        this.device.sendPacket({
            type: 'kdeconnect.telephony.request_mute',
            body: {},
        });

        this._restoreMediaState();
    }

    _ensureWindow() {
        if (this._window === null) {
            this._window = new CallWindow({
                application: Gio.Application.get_default(),
                device: this.device,
                plugin: this,
            });
            this._window.connect('close-request', () => {
                this._window = null;
            });
        }

        return this._window;
    }

    destroy() {
        if (this._window !== null) {
            this._window.close();
            this._window = null;
        }

        this._clearCallWatch();

        if (this._bluetoothCallsChangedId !== 0) {
            this._bluetoothTelephony.disconnect(this._bluetoothCallsChangedId);
            this._bluetoothCallsChangedId = 0;
        }

        this._incomingSender = null;
        this._incomingCallNumber = null;
        this._incomingCallPath = null;

        if (this._bluetoothTelephony !== undefined)
            this._bluetoothTelephony = Components.release('bluetoothtelephony');

        if (this._mixer !== undefined)
            this._mixer = Components.release('pulseaudio');

        if (this._mpris !== undefined)
            this._mpris = Components.release('mpris');

        super.destroy();
    }
});

const CallWindow = GObject.registerClass({
    GTypeName: 'GSConnectTelephonyCallWindow',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this window',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The plugin placing calls',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
    },
}, class CallWindow extends Adw.ApplicationWindow {

    _init(params) {
        super._init(params);

        this.title = _('Call');
        this.default_width = 320;
        this.default_height = 560;
        this.width_request = 320;
        this.height_request = 480;

        this.nav_view = new Adw.NavigationView({
            visible: true,
        });
        this.content = this.nav_view;
        this._hangupAction = 'dialer';

        this._chooser = new Contacts.ContactChooser({
            device: this.device,
            // TRANSLATORS: A phone number (eg. "Call 555-5555")
            'number-label': _('Call %s'),
        });
        this._chooser.show_back_button = true;
        this._numberSelectedId = this._chooser.connect(
            'number-selected',
            this._onNumberSelected.bind(this)
        );
        this._dialerPage = new CallDialerPage({
            plugin: this.plugin,
        });
        this._statusPage = new CallStatusPage({
            plugin: this.plugin,
        });
        this._contactsClickedId = this._dialerPage.connect(
            'contacts-clicked',
            this._onContactsClicked.bind(this)
        );

        this.nav_view.push(this._dialerPage);
    }

    get device() {
        return this._device ?? null;
    }

    set device(device) {
        this._device = device;
    }

    get plugin() {
        return this._plugin ?? null;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }

    _onNumberSelected(chooser, number) {
        this._dial(number);
    }

    _onContactsClicked() {
        this.nav_view.push(this._chooser);
    }

    _dial(number) {
        if (!number)
            return;

        this.showCall(number, 'dialing', null, 'dialer');

        this.plugin._dial(number).then(callPath => {
            if (typeof callPath === 'string')
                this._statusPage.call_path = callPath;
            else if (callPath?.error)
                this._statusPage.showError(callPath.title, callPath.message);
            else if (!callPath)
                this._statusPage.state = 'opened';
        }).catch(e => {
            debug(e, this.device.name);
            this._statusPage.showError(_('Call Failed'), e.message);
        });
    }

    get call_path() {
        return this._statusPage.call_path;
    }

    set call_path(callPath) {
        this._statusPage.call_path = callPath;
    }

    showCall(number, state = 'talking', callPath = null, hangupAction = null) {
        this._statusPage.number = number ?? '';
        this._statusPage.call_path = callPath ?? this._statusPage.call_path;
        this._statusPage.state = state;

        if (hangupAction !== null)
            this._hangupAction = hangupAction;

        if (this.nav_view.get_visible_page() !== this._statusPage)
            this.nav_view.push(this._statusPage);

        this.present();
    }

    finishCall() {
        if (this._hangupAction === 'dialer')
            this.showDialer();
        else
            this.close();
    }

    showDialer() {
        this._statusPage.number = '';
        this._statusPage.call_path = '';
        this._dialerPage.number = '';
        this._hangupAction = 'dialer';

        while (this.nav_view.get_visible_page() !== this._dialerPage)
            this.nav_view.pop();

        this.present();
    }

    vfunc_close_request() {
        if (this._numberSelectedId !== 0) {
            this._chooser.disconnect(this._numberSelectedId);
            this._numberSelectedId = 0;
        }

        if (this._contactsClickedId !== 0) {
            this._dialerPage.disconnect(this._contactsClickedId);
            this._contactsClickedId = 0;
        }

        return false;
    }
});

const CallDialerPage = GObject.registerClass({
    GTypeName: 'GSConnectTelephonyCallDialerPage',
    Properties: {
        'number': GObject.ParamSpec.string(
            'number',
            'Number',
            'The number to call',
            GObject.ParamFlags.READWRITE,
            ''
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The plugin placing calls',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
    },
    Signals: {
        'contacts-clicked': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [],
        },
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/telephony-call-dialer-page.ui',
    Children: ['backspace-button', 'call-button', 'contacts-button', 'number-label'],
}, class CallDialerPage extends Adw.NavigationPage {

    _init(params) {
        super._init(params);

        const keyController = new Gtk.EventControllerKey();
        keyController.connect('key-pressed',
            this._onKeyPressed.bind(this));
        this.add_controller(keyController);
        this.focusable = true;
    }

    get number() {
        return this._number ?? '';
    }

    set number(number) {
        this._number = number ?? '';

        if (this.number_label === undefined)
            return;

        this.number_label.label = this._number;
        this.backspace_button.visible = this._number.length > 0;
        this.call_button.sensitive = this._number.length > 0;
    }

    get plugin() {
        return this._plugin ?? null;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }

    _appendDigit(digit) {
        this.number = `${this.number}${digit}`;
    }

    _backspace() {
        this.number = this.number.slice(0, -1);
    }

    _onDigitClicked(button) {
        this._appendDigit(button.label);
    }

    _onBackspaceClicked() {
        this._backspace();
    }

    _onCallClicked() {
        const root = this.get_root();

        if (root instanceof CallWindow)
            root._dial(this.number);
    }

    _onContactsClicked() {
        this.emit('contacts-clicked');
    }

    _onKeyPressed(controller, keyval) {
        const unicode = Gdk.keyval_to_unicode(keyval);

        if (unicode !== 0) {
            const char = String.fromCharCode(unicode);

            if (/^[0-9*#+]$/.test(char)) {
                this._appendDigit(char);
                return Gdk.EVENT_STOP;
            }
        }

        if (keyval === Gdk.KEY_BackSpace) {
            this._backspace();
            return Gdk.EVENT_STOP;
        }

        if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
            if (this.number.length > 0)
                this._onCallClicked();

            return Gdk.EVENT_STOP;
        }

        return Gdk.EVENT_PROPAGATE;
    }
});

const CallStatusPage = GObject.registerClass({
    GTypeName: 'GSConnectTelephonyCallStatusPage',
    Properties: {
        'number': GObject.ParamSpec.string(
            'number',
            'Number',
            'The active call phone number',
            GObject.ParamFlags.READWRITE,
            ''
        ),
        'call-path': GObject.ParamSpec.string(
            'call-path',
            'Call Path',
            'The active call object path',
            GObject.ParamFlags.READWRITE,
            ''
        ),
        'plugin': GObject.ParamSpec.object(
            'plugin',
            'Plugin',
            'The plugin controlling calls',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
        'state': GObject.ParamSpec.string(
            'state',
            'State',
            'The active call state',
            GObject.ParamFlags.READWRITE,
            'dialing'
        ),
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/telephony-call-status-page.ui',
    Children: [
        'answer-button',
        'hangup-button',
        'number-label',
        'status-image',
        'title-label',
    ],
}, class CallStatusPage extends Adw.NavigationPage {

    get number() {
        return this._number ?? '';
    }

    set number(number) {
        this._number = number ?? '';

        if (this.number_label !== undefined)
            this.number_label.label = this._number;
    }

    get plugin() {
        return this._plugin ?? null;
    }

    set plugin(plugin) {
        this._plugin = plugin;
    }

    get call_path() {
        return this._call_path ?? '';
    }

    set call_path(callPath) {
        this._call_path = callPath ?? '';
    }

    get state() {
        return this._state ?? 'dialing';
    }

    set state(state) {
        this._state = state;

        if (this.title_label === undefined)
            return;

        this.number_label.label = this.number;
        this.status_image.icon_name = 'call-start-symbolic';
        this.hangup_button.visible = true;

        switch (state) {
            case 'error':
                this.answer_button.visible = false;
                this.hangup_button.visible = false;
                this.status_image.icon_name = 'call-outgoing-unsuccessful-symbolic';
                break;

            case 'incoming':
                // TRANSLATORS: A phone call is ringing
                this.title_label.label = _('Incoming Call');
                this.answer_button.visible = true;
                break;

            case 'opened':
                // TRANSLATORS: A call was opened on the paired phone
                this.title_label.label = _('Opened on Phone');
                this.answer_button.visible = false;
                break;

            case 'ending':
                // TRANSLATORS: A phone call is ending
                this.title_label.label = _('Ending Call');
                this.answer_button.visible = false;
                break;

            case 'talking':
                // TRANSLATORS: A phone call is active
                this.title_label.label = _('Ongoing Call');
                this.answer_button.visible = false;
                break;

            case 'dialing':
            default:
                // TRANSLATORS: A phone call is being placed
                this.title_label.label = _('Calling');
                this.answer_button.visible = false;
                break;
        }
    }

    showError(title, message) {
        this._state = 'error';
        this.title_label.label = title;
        this.number_label.label = message;
        this.status_image.icon_name = 'call-outgoing-unsuccessful-symbolic';
        this.answer_button.visible = false;
        this.hangup_button.visible = false;
    }

    _onAnswerClicked() {
        this.answer_button.sensitive = false;

        Promise.resolve(this.plugin.answerCall(this.number, this.call_path))
            .then(answered => {
                if (answered)
                    this.state = 'talking';
                else
                    this.showAnswerError();
            })
            .catch(e => {
                debug(e, this.plugin.device.name);
                this.showAnswerError();
            });
    }

    showAnswerError() {
        // TRANSLATORS: An incoming call could not be answered from the PC
        this.title_label.label = _('Could Not Answer Call');
        this.status_image.icon_name = 'call-outgoing-unsuccessful-symbolic';
        this.answer_button.sensitive = true;
        this.answer_button.visible = true;
        this.hangup_button.visible = true;
    }

    _onHangupClicked() {
        this.state = 'ending';

        const root = this.get_root();

        Promise.resolve(this.plugin.hangupCall(this.number, this.call_path))
            .catch(e => debug(e, this.plugin.device.name));

        if (root instanceof CallWindow)
            root.finishCall();
    }
});

export default CallsPlugin;
