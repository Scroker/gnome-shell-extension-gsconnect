// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Plugin from '../plugin.js';
import LegacyMessagingDialog from '../ui/legacyMessaging.js';
import {MessagingWindow, ConversationChooser} from '../ui/messaging.js';
import SmsURI from '../utils/uri.js';


export const Metadata = {
    label: _('SMS'),
    description: _('Send and read SMS of the paired device and be notified of new SMS'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.SMS',
    incomingCapabilities: [
        'kdeconnect.sms.messages',
    ],
    outgoingCapabilities: [
        'kdeconnect.sms.request',
        'kdeconnect.sms.request_conversation',
        'kdeconnect.sms.request_conversations',
    ],
    actions: {
        // SMS Actions
        sms: {
            label: _('Messaging'),
            icon_name: 'chat-bubbles-text-symbolic',

            parameter_type: null,
            incoming: [],
            outgoing: ['kdeconnect.sms.request'],
        },
        uriSms: {
            label: _('New SMS (URI)'),
            icon_name: 'chat-bubbles-text-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request'],
        },
        replySms: {
            label: _('Reply SMS'),
            icon_name: 'chat-bubbles-text-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request'],
        },
        sendMessage: {
            label: _('Send Message'),
            icon_name: 'paper-plane-symbolic',

            parameter_type: new GLib.VariantType('(aa{sv})'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request'],
        },
        sendSms: {
            label: _('Send SMS'),
            icon_name: 'paper-plane-symbolic',

            parameter_type: new GLib.VariantType('(ss)'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request'],
        },
        shareSms: {
            label: _('Share SMS'),
            icon_name: 'paper-plane-symbolic',

            parameter_type: new GLib.VariantType('s'),
            incoming: [],
            outgoing: ['kdeconnect.sms.request'],
        },
    },
};


/**
 * SMS Message event type. Currently all events are TEXT_MESSAGE.
 *
 * TEXT_MESSAGE: Has a "body" field which contains pure, human-readable text
 */
export const MessageEventType = {
    TEXT_MESSAGE: 0x1,
};


/**
 * SMS Message status. READ/UNREAD match the 'read' field from the Android App
 * message packet.
 *
 * UNREAD: A message not marked as read
 * READ: A message marked as read
 */
export const MessageStatus = {
    UNREAD: 0,
    READ: 1,
};


/**
 * SMS Message type, set from the 'type' field in the Android App
 * message packet.
 *
 * See: https://developer.android.com/reference/android/provider/Telephony.TextBasedSmsColumns.html
 *
 * ALL: all messages
 * INBOX: Received messages
 * SENT: Sent messages
 * DRAFT: Message drafts
 * OUTBOX: Outgoing messages
 * FAILED: Failed outgoing messages
 * QUEUED: Messages queued to send later
 */
export const MessageBox = {
    ALL: 0,
    INBOX: 1,
    SENT: 2,
    DRAFT: 3,
    OUTBOX: 4,
    FAILED: 5,
    QUEUED: 6,
};

const THREAD_REQUEST_DELAY = 250;
const THREAD_REQUEST_TIMEOUT = 10000;
const THREAD_REQUEST_RETRIES = 2;


/**
 * SMS Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/sms
 * https://github.com/KDE/kdeconnect-android/tree/master/src/org/kde/kdeconnect/Plugins/SMSPlugin/
 */
const SMSPlugin = GObject.registerClass({
    GTypeName: 'GSConnectSMSPlugin',
    Properties: {
        'threads': GObject.param_spec_variant(
            'threads',
            'Conversation List',
            'A list of threads',
            new GLib.VariantType('aa{sv}'),
            null,
            GObject.ParamFlags.READABLE
        ),
    },
}, class SMSPlugin extends Plugin {

    _init(device) {
        super._init(device, 'sms');

        this._pendingDigest = false;
        this._requestedThreads = new Set();
        this._pendingThreads = new Set();
        this._threadRequests = new Map();
        this._completeThreads = new Set();
        this._activeThreadId = null;

        this.cacheProperties(['_threads']);
    }

    get threads() {
        if (this._threads === undefined)
            this._threads = {};

        return this._threads;
    }

    get window() {
        if (this._window === undefined) {
            if (this.settings.get_boolean('legacy-sms')) {
                this._window = new LegacyMessagingDialog({
                    application: Gio.Application.get_default(),
                    device: this.device,
                    plugin: this,
                });
            } else {
                this._window = new MessagingWindow({
                    application: Gio.Application.get_default(),
                    device: this.device,
                    plugin: this,
                });
            }

            this._windowId = this._window.connect('close-request', () => {
                this._window = undefined;
            });
        }

        return this._window;
    }

    clearCache() {
        this._threads = {};
        this._pendingDigest = false;
        this._requestedThreads.clear();
        this._pendingThreads.clear();
        this._clearThreadRequests();
        this._completeThreads.clear();
        this._activeThreadId = null;
        this.notify('threads');
    }

    cacheLoaded() {
        this._normalizeThreads();
        this._completeThreads.clear();

        for (const [thread_id, thread] of Object.entries(this.threads)) {
            if (thread.length > 1)
                this._completeThreads.add(thread_id);
        }

        this.notify('threads');
    }

    isThreadLoading(thread_id) {
        return this._pendingThreads.has(`${thread_id}`);
    }

    requestConversation(thread_id) {
        thread_id = `${thread_id}`;
        this._activeThreadId = thread_id;

        const changed = this._cancelInactiveThreadRequests(thread_id);

        if (!this._requestConversation(thread_id) && changed)
            this.notify('threads');
    }

    _finishThreadRequest(thread_id) {
        thread_id = `${thread_id}`;

        const request = this._threadRequests.get(thread_id);

        if (request !== undefined) {
            if (request.source !== 0)
                GLib.Source.remove(request.source);

            this._threadRequests.delete(thread_id);
        }

        this._pendingThreads.delete(thread_id);
        this._requestedThreads.delete(thread_id);
    }

    _cancelInactiveThreadRequests(active_thread_id) {
        let changed = false;

        for (const thread_id of [...this._pendingThreads]) {
            if (thread_id !== active_thread_id) {
                this._finishThreadRequest(thread_id);
                changed = true;
            }
        }

        return changed;
    }

    _clearThreadRequests() {
        for (const request of this._threadRequests.values()) {
            if (request.source !== 0)
                GLib.Source.remove(request.source);
        }

        this._threadRequests.clear();
    }

    _getThreadCache(thread_id) {
        const cache = this.threads[thread_id];

        if (Array.isArray(cache))
            return cache;

        if (cache && typeof cache === 'object')
            return [cache];

        return [];
    }

    _normalizeThreads() {
        for (const [thread_id, thread] of Object.entries(this.threads)) {
            if (Array.isArray(thread))
                continue;

            if (thread && typeof thread === 'object') {
                thread.thread_id = `${thread.thread_id ?? thread_id}`;
                this.threads[thread_id] = [thread];
            } else {
                delete this.threads[thread_id];
            }
        }
    }

    connected() {
        super.connected();
        this._requestConversations();
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.sms.messages':
                this._handleMessages(packet.body.messages);
                break;
        }
    }

    /**
     * Handle a digest of threads.
     *
     * @param {object[]} messages - A list of message objects
     * @param {string[]} thread_ids - A list of thread IDs as strings
     */
    _handleDigest(messages, thread_ids) {
        this._normalizeThreads();

        // Merge each thread summary into the cache
        for (let i = 0, len = messages.length; i < len; i++) {
            const message = messages[i];
            const cache = this.threads[message.thread_id];

            if (cache === undefined) {
                this.threads[message.thread_id] = [message];
                this._completeThreads.delete(message.thread_id);
                continue;
            }

            const latest = (cache.length) ? cache[cache.length - 1].date : 0;

            // If this message is marked read, mark the rest as read
            if (message.read === MessageStatus.READ) {
                for (const msg of cache)
                    msg.read = MessageStatus.READ;
            }

            if (cache.find(msg => msg.date === message.date) === undefined) {
                cache.push(message);
                this.threads[message.thread_id] = cache.sort((a, b) => a.date - b.date);

                if (message.date > latest)
                    this._completeThreads.delete(message.thread_id);
            }
        }

        this._requestPendingConversations();
        this.notify('threads');
    }

    /**
     * Handle a new single message
     *
     * @param {object} message - A message object
     * @param {boolean} scroll - Whether to scroll an open conversation to it
     */
    _handleMessage(message, scroll = false) {
        let conversation = null;

        // If the window is open, try and find an active conversation
        if (this._window)
            conversation = this._window.getConversationForMessage(message);

        // If there's an active conversation, we should log the message now
        if (conversation)
            conversation.addMessage(message, scroll);
    }

    /**
     * Parse a conversation (thread of messages) and sort them
     *
     * @param {object[]} thread - A list of sms message objects from a thread
     * @param {boolean} requested - Whether this is a response to our request
     */
    _handleThread(thread, requested = false) {
        const thread_id = thread[0].thread_id;

        if (requested)
            this._finishThreadRequest(thread_id);

        // If there are no addresses this will cause major problems...
        if (!thread[0].addresses || !thread[0].addresses[0]) {
            if (requested)
                this.notify('threads');
            return;
        }

        const cache = this._getThreadCache(thread_id);

        // Handle each message
        for (let i = 0, len = thread.length; i < len; i++) {
            const message = thread[i];

            // TODO: We only cache messages of a known MessageBox since we
            // have no reliable way to determine its direction, let alone
            // what to do with it.
            if (message.type < 0 || message.type > 6)
                continue;

            // If the message exists, just update it
            const cacheMessage = cache.find(m => m.date === message.date);

            if (cacheMessage) {
                Object.assign(cacheMessage, message);
            } else {
                cache.push(message);
                this._handleMessage(message, !requested);
            }
        }

        // Sort the thread by ascending date and notify
        this.threads[thread_id] = cache.sort((a, b) => a.date - b.date);

        if (requested)
            this._completeThreads.add(thread_id);

        this.notify('threads');
    }

    /**
     * Handle a response to telephony.request_conversation(s)
     *
     * @param {object[]} messages - A list of sms message objects
     */
    _handleMessages(messages) {
        try {
            // If messages is empty there's nothing to do...
            if (messages.length === 0) {
                if (this._pendingDigest)
                    this._pendingDigest = false;

                this._requestedThreads.clear();
                this._pendingThreads.clear();
                this._clearThreadRequests();
                this.notify('threads');
                return;
            }

            const thread_ids = [];

            // Perform some modification of the messages
            for (let i = 0, len = messages.length; i < len; i++) {
                const message = messages[i];

                // COERCION: thread_id's to strings
                message.thread_id = `${message.thread_id}`;
                thread_ids.push(message.thread_id);

                // TODO: Remove bogus `insert-address-token` entries
                let a = message.addresses.length;

                while (a--) {
                    if (message.addresses[a].address === undefined ||
                        message.addresses[a].address === 'insert-address-token')
                        message.addresses.splice(a, 1);
                }
            }

            const unique_thread_ids = [...new Set(thread_ids)];
            const requested = unique_thread_ids.length === 1 &&
                this._requestedThreads.has(unique_thread_ids[0]);

            // If this is a response to request_conversations or there's
            // multiple thread_id's, it's a summary of threads
            if ((this._pendingDigest && !requested) ||
                unique_thread_ids.length > 1) {
                this._pendingDigest = false;
                this._handleDigest(messages, unique_thread_ids);
            } else {
                // Otherwise this is single thread or new message
                this._handleThread(messages, requested);
            }
        } catch (e) {
            debug(e, this.device.name);
        }
    }

    /**
     * Request a list of messages from a single thread.
     *
     * @param {number} thread_id - The id of the thread to request
     * @returns {boolean} Whether a request is pending
     */
    _requestConversation(thread_id) {
        thread_id = `${thread_id}`;

        if (this._completeThreads.has(thread_id))
            return false;

        if (this.threads[thread_id] === undefined)
            return false;

        if (this._pendingThreads.has(thread_id))
            return false;

        this._pendingThreads.add(thread_id);
        this.notify('threads');

        if (this._pendingDigest)
            return true;

        this._queueConversationRequest(thread_id);
        return true;
    }

    _queueConversationRequest(thread_id) {
        if (this._requestedThreads.has(thread_id))
            return;

        const request = this._threadRequests.get(thread_id) ?? {
            retries: 0,
            source: 0,
        };

        if (request.source !== 0)
            GLib.Source.remove(request.source);

        request.source = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            THREAD_REQUEST_DELAY,
            () => this._sendQueuedConversationRequest(thread_id)
        );

        this._threadRequests.set(thread_id, request);
    }

    _sendQueuedConversationRequest(thread_id) {
        const request = this._threadRequests.get(`${thread_id}`);

        if (request !== undefined)
            request.source = 0;

        if (!this._pendingThreads.has(`${thread_id}`))
            return GLib.SOURCE_REMOVE;

        if (this._activeThreadId !== null && `${thread_id}` !== this._activeThreadId)
            return GLib.SOURCE_REMOVE;

        this._sendConversationRequest(thread_id);
        return GLib.SOURCE_REMOVE;
    }

    _sendConversationRequest(thread_id) {
        if (this._requestedThreads.has(thread_id))
            return;

        this._requestedThreads.add(thread_id);
        this._scheduleThreadRequestTimeout(thread_id);

        this.device.sendPacket({
            type: 'kdeconnect.sms.request_conversation',
            body: {
                threadID: thread_id,
            },
        });
    }

    _scheduleThreadRequestTimeout(thread_id) {
        const request = this._threadRequests.get(thread_id) ?? {
            retries: 0,
            source: 0,
        };

        if (request.source !== 0)
            GLib.Source.remove(request.source);

        request.source = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            THREAD_REQUEST_TIMEOUT,
            () => this._onThreadRequestTimeout(thread_id)
        );

        this._threadRequests.set(thread_id, request);
    }

    _retryThreadRequest(thread_id) {
        thread_id = `${thread_id}`;

        const request = this._threadRequests.get(thread_id);

        if (request === undefined || !this._pendingThreads.has(thread_id))
            return;

        if (request.retries >= THREAD_REQUEST_RETRIES) {
            debug(`Timed out requesting SMS thread ${thread_id}`, this.device.name);
            this._finishThreadRequest(thread_id);
            this.notify('threads');
            return;
        }

        request.retries += 1;
        this._requestedThreads.delete(thread_id);
        this._sendConversationRequest(thread_id);
    }

    _onThreadRequestTimeout(thread_id) {
        const request = this._threadRequests.get(`${thread_id}`);

        if (request !== undefined)
            request.source = 0;

        this._retryThreadRequest(thread_id);
        return GLib.SOURCE_REMOVE;
    }

    _requestPendingConversations() {
        for (const thread_id of this._pendingThreads) {
            if (this._activeThreadId !== null && thread_id !== this._activeThreadId)
                continue;

            this._queueConversationRequest(thread_id);
        }
    }

    /**
     * Request a list of the last message in each unarchived thread.
     */
    _requestConversations() {
        if (this._pendingDigest)
            return;

        this._pendingDigest = true;
        this.device.sendPacket({
            type: 'kdeconnect.sms.request_conversations',
        });
    }

    /**
     * A notification action for replying to SMS messages (or missed calls).
     *
     * @param {string} hint - Could be either a contact name or phone number
     */
    replySms(hint) {
        const window = this.window;

        window.present();
        this._requestConversations();
        window.openConversationForHint(hint);
    }

    /**
     * Send an SMS message
     *
     * @param {string} phoneNumber - The phone number to send the message to
     * @param {string} messageBody - The message to send
     */
    sendSms(phoneNumber, messageBody) {
        this.device.sendPacket({
            type: 'kdeconnect.sms.request',
            body: {
                sendSms: true,
                phoneNumber: phoneNumber,
                messageBody: messageBody,
            },
        });
    }

    /**
     * Send a message
     *
     * @param {object[]} addresses - A list of address objects
     * @param {string} messageBody - The message text
     * @param {number} [event] - An event bitmask
     * @param {boolean} [forceSms] - Whether to force SMS
     * @param {number} [subId] - The SIM card to use
     */
    sendMessage(addresses, messageBody, event = 1, forceSms = false, subId = undefined) {
        // TODO: waiting on support in kdeconnect-android
        // if (this._version === 1) {
        this.device.sendPacket({
            type: 'kdeconnect.sms.request',
            body: {
                sendSms: true,
                phoneNumber: addresses[0].address,
                messageBody: messageBody,
            },
        });
        // } else if (this._version === 2) {
        //     this.device.sendPacket({
        //         type: 'kdeconnect.sms.request',
        //         body: {
        //             version: 2,
        //             addresses: addresses,
        //             messageBody: messageBody,
        //             forceSms: forceSms,
        //             sub_id: subId
        //         }
        //     });
        // }
    }

    /**
     * Share a text content by SMS message. This is used by the WebExtension to
     * share URLs from the browser, but could be used to initiate sharing of any
     * text content.
     *
     * @param {string} url - The link to be shared
     */
    shareSms(url) {
        // Legacy Mode
        if (this.settings.get_boolean('legacy-sms')) {
            const window = this.window;
            window.present();
            window.setMessage(url);

        // If there are active threads, show the chooser dialog
        } else if (Object.values(this.threads).length > 0) {
            const window = new ConversationChooser({
                application: Gio.Application.get_default(),
                device: this.device,
                message: url,
                plugin: this,
            });

            window.present();

        // Otherwise show the window and wait for a contact to be chosen
        } else {
            this.window.present();
            this.window.setMessage(url, true);
        }
    }

    /**
     * Open and present the messaging window
     */
    sms() {
        this.window.present();
    }

    /**
     * This is the sms: URI scheme handler
     *
     * @param {string} uri - The URI the handle (sms:|sms://|sms:///)
     */
    uriSms(uri) {
        try {
            uri = new SmsURI(uri);

            // Lookup contacts
            const addresses = uri.recipients.map(number => {
                return {address: number.toPhoneNumber()};
            });
            const contacts = this.device.contacts.lookupAddresses(addresses);

            // Present the window and show the conversation
            const window = this.window;
            window.present();
            window.setContacts(contacts);

            // Set the outgoing message if the uri has a body variable
            if (uri.body)
                window.setMessage(uri.body);
        } catch (e) {
            debug(e, `${this.device.name}: "${uri}"`);
        }
    }

    _threadHasAddress(thread, addressObj) {
        if (!thread?.[0]?.addresses)
            return false;

        const number = addressObj.address.toPhoneNumber();

        for (const taddressObj of thread[0].addresses) {
            const tnumber = taddressObj.address.toPhoneNumber();

            if (number.endsWith(tnumber) || tnumber.endsWith(number))
                return true;
        }

        return false;
    }

    /**
     * Try to find a thread_id in for {@link addresses}.
     *
     * @param {object[]} addresses - a list of address objects
     * @returns {string|null} a thread ID
     */
    getThreadIdForAddresses(addresses = []) {
        const threads = Object.values(this.threads);

        for (const thread of threads) {
            if (!thread?.[0]?.addresses)
                continue;

            if (addresses.length !== thread[0].addresses.length)
                continue;

            if (addresses.every(addressObj => this._threadHasAddress(thread, addressObj)))
                return thread[0].thread_id;
        }

        return null;
    }

    destroy() {
        if (this._window !== undefined) {
            const window = this._window;
            window.close();
            window.disconnect(this._windowId);
        }

        this._clearThreadRequests();
        super.destroy();
    }
});

export default SMSPlugin;
