// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';

import {normalizePhoneNumber, phoneNumbersEqual} from '../utils/phone.js';

/**
 * Return a localized string for a phone number type
 * See: http://www.ietf.org/rfc/rfc2426.txt
 *
 * @param {string} type - An RFC2426 phone number type
 * @returns {string} A localized string like 'Mobile'
 */
function getNumberTypeLabel(type) {
    if (type.includes('fax'))
        // TRANSLATORS: A fax number
        return _('Fax');

    if (type.includes('work'))
        // TRANSLATORS: A work or office phone number
        return _('Work');

    if (type.includes('cell'))
        // TRANSLATORS: A mobile or cellular phone number
        return _('Mobile');

    if (type.includes('home'))
        // TRANSLATORS: A home phone number
        return _('Home');

    // TRANSLATORS: All other phone number types
    return _('Other');
}

/**
 * Get a display number from {@link contact} for {@link address}.
 *
 * @param {object} contact - A contact object
 * @param {string} address - A phone number
 * @returns {string} A (possibly) better display number for the address
 */
export function getDisplayNumber(contact, address) {
    for (const contactNumber of contact.numbers) {
        if (phoneNumbersEqual(address, contactNumber.value))
            return GLib.markup_escape_text(contactNumber.value, -1);
    }

    return GLib.markup_escape_text(address, -1);
}

/**
 * A row for a contact address (usually a phone number).
 */
const AddressRow = GObject.registerClass({
    GTypeName: 'GSConnectContactsAddressRow',
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/contacts-address-row.ui',
    Children: ['avatar', 'type-label'],
}, class AddressRow extends Adw.ActionRow {

    _init(contact, index = 0) {
        super._init();

        this._index = index;
        this._number = contact.numbers[index];
        this.contact = contact;

        this._selectedImage = new Gtk.Image({
            icon_name: 'object-select-symbolic',
            visible: false,
        });
        this.add_suffix(this._selectedImage);
    }

    get contact() {
        if (this._contact === undefined)
            this._contact = null;

        return this._contact;
    }

    set contact(contact) {
        if (this.contact === contact)
            return;

        this._contact = contact;

        if (this._index === 0) {
            this.avatar.text = contact.name;
            this.title = GLib.markup_escape_text(contact.name, -1);
        }

        this.subtitle = GLib.markup_escape_text(this.number.value, -1);

        if (this.number.type !== undefined)
            this.type_label.label = getNumberTypeLabel(this.number.type);
    }

    get number() {
        if (this._number === undefined)
            return {value: 'unknown', type: 'unknown'};

        return this._number;
    }

    get selected() {
        return this._selected ?? false;
    }

    set selected(selected) {
        this._selected = selected;

        if (this._selectedImage !== undefined)
            this._selectedImage.visible = selected;
    }
});


/**
 * A widget for selecting contact addresses (usually phone numbers)
 */
export const ContactChooser = GObject.registerClass({
    GTypeName: 'GSConnectContactChooser',
    Properties: {
        'device': GObject.ParamSpec.object(
            'device',
            'Device',
            'The device associated with this window',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
        'store': GObject.ParamSpec.object(
            'store',
            'Store',
            'The contacts store',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
            GObject.Object
        ),
        'number-label': GObject.ParamSpec.string(
            'number-label',
            'Number Label',
            'The format string for manually entered phone numbers',
            GObject.ParamFlags.READWRITE,
            null
        ),
        'selection-mode': GObject.ParamSpec.string(
            'selection-mode',
            'Selection Mode',
            'Whether number selection is single or multiple',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
            'single'
        ),
        'show-selection-mode-button': GObject.ParamSpec.boolean(
            'show-selection-mode-button',
            'Show Selection Mode Button',
            'Whether to show the multiple selection toggle',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
            false
        ),
    },
    Signals: {
        'number-selected': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING],
        },
        'selection-confirmed': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [],
        },
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/contact-chooser.ui',
    Children: [
        'button-search', 'search-bar', 'search-entry',
        'confirm-button', 'selection-label', 'selection-mode-button',
        'selection-bar', 'scrolled', 'list', 'header-bar',

    ],
}, class ContactChooser extends Adw.NavigationPage {

    _init(params) {
        super._init(params);

        // Setup the contact list
        this.list._entry = this.search_entry.text;
        this.list.set_filter_func(this._filter.bind(this));
        this.list.set_sort_func(this._sort);
        this.row_list = [];
        this.selected_rows = {};
        this._selectedRows = new Map();
        this._updateSelectionState();

        // Make sure we're using the correct contacts store
        this.device.bind_property(
            'contacts',
            this,
            'store',
            GObject.BindingFlags.SYNC_CREATE
        );

        // Make sure we're using the correct contacts store
        this.button_search.bind_property(
            'active',
            this.search_bar,
            'search-mode-enabled',
            GObject.BindingFlags.SYNC_CREATE
        );

        // Cleanup on ::destroy
        this.connect('destroy', this._onDestroy);

        const search_esc_controller = new Gtk.EventControllerKey();
        search_esc_controller.connect('key-pressed', (controller, keyval, keycode, state) => {
            if (keyval === Gdk.KEY_Escape)
                this.button_search.active = false;
        });
        this.search_entry.add_controller(search_esc_controller);

        this.search_entry.connect('search-changed', this._onSearchChanged.bind(this));
    }

    get store() {
        if (this._store === undefined)
            this._store = null;

        return this._store;
    }

    set store(store) {
        if (this.store === store)
            return;

        // Unbind the old store
        if (this._store) {
            // Disconnect from the store
            this._store.disconnect(this._contactAddedId);
            this._store.disconnect(this._contactRemovedId);
            this._store.disconnect(this._contactChangedId);

            // Clear the contact list
            this.row_list.forEach(row => {
                this.list.remove(row);
            });
            this.row_list = [];
        }

        // Set the store
        this._store = store;

        // Bind the new store
        if (this._store) {
            // Connect to the new store
            this._contactAddedId = store.connect(
                'contact-added',
                this._onContactAdded.bind(this)
            );

            this._contactRemovedId = store.connect(
                'contact-removed',
                this._onContactRemoved.bind(this)
            );

            this._contactChangedId = store.connect(
                'contact-changed',
                this._onContactChanged.bind(this)
            );

            // Populate the list
            this._populate();
        }
    }

    get number_label() {
        if (this._number_label === undefined)
            // TRANSLATORS: A phone number (eg. "Send to 555-5555")
            this._number_label = _('Send to %s');

        return this._number_label;
    }

    set number_label(label) {
        this._number_label = label;
    }

    /**
     * Getter and Setter for the back button visibility.
     *
     * @type {object} store - The new contact store.
     */
    get show_back_button() {
        return this.header_bar.show_back_button;
    }

    set show_back_button(value) {
        this.header_bar.show_back_button = value;
    }

    get selection_mode() {
        return this._selection_mode ?? 'single';
    }

    set selection_mode(selection_mode) {
        const mode = selection_mode === 'multiple' ? 'multiple' : 'single';

        if (this.selection_mode === mode)
            return;

        this._selection_mode = mode;

        if (this.selection_mode_button !== undefined)
            this.selection_mode_button.active = mode === 'multiple';

        if (mode === 'single')
            this.clearSelection();

        this._updateSelectionState();
    }

    get show_selection_mode_button() {
        return this._show_selection_mode_button ?? false;
    }

    set show_selection_mode_button(show) {
        this._show_selection_mode_button = show;
        this._updateSelectionState();
    }

    /*
     * ContactStore Callbacks
     */
    _onContactAdded(store, id) {
        const contact = this.store.get_contact(id);
        this._addContact(contact);
    }

    _onContactRemoved(store, id) {
        const removed_rows = [];
        const new_row_list = [];

        this.row_list.forEach(row => {
            if (row.contact.id === id)
                removed_rows.push(row);
            else
                new_row_list.push(row);

        });

        if (removed_rows.length > 0) {
            for (const row of removed_rows)
                this.list.remove(row);

            this.row_list = new_row_list;
        }
    }

    _onContactChanged(store, id) {
        this._onContactRemoved(store, id);
        this._onContactAdded(store, id);
    }

    _onDestroy(chooser) {
        chooser.store = null;
    }

    _onSearchChanged(entry) {
        this.list._entry = entry.text;
        let dynamic = this.list.get_row_at_index(0);

        // If the entry contains string with 2 or more digits...
        if (entry.text.replace(/\D/g, '').length >= 2) {
            // ...ensure we have a dynamic contact for it
            if (!dynamic || !dynamic.__tmp) {
                dynamic = new AddressRow({
                    name: this.number_label.format(entry.text),
                    numbers: [{type: 'unknown', value: entry.text}],
                });
                dynamic.connect('activated', this._onNumberSelected.bind(this));
                dynamic.__tmp = true;
                this.list.append(dynamic);
                this.row_list.push(dynamic);

            // ...or if we already do, then update it
            } else {
                const address = entry.text;

                // Update contact object
                dynamic.contact.name = address;
                dynamic.contact.numbers[0].value = address;

                // Update UI
                dynamic.title = this.number_label.format(address);
                dynamic.subtitle = address;
            }

        // ...otherwise remove any dynamic contact that's been created
        } else if (dynamic && dynamic.__tmp) {
            this.list.remove(dynamic);
        }

        this.list.invalidate_filter();
        this.list.invalidate_sort();
    }

    // GtkListBox::row-activated
    _onNumberSelected(row) {
        if (row === undefined)
            return;

        if (this.selection_mode === 'multiple')
            return this._toggleNumber(row);

        // Emit the number
        const address = row.number.value;
        this.selected_rows = {};
        this.selected_rows[row.number.value] = row.contact;
        this.emit('number-selected', address);

        // Reset the contact list
        this.search_entry.text = '';
        this.list.select_row(null);
        this.scrolled.vadjustment.value = 0;
    }

    _toggleNumber(row) {
        const address = row.number.value;

        if (this.selected_rows[address] !== undefined) {
            delete this.selected_rows[address];
            row.selected = false;
            this._selectedRows.delete(address);
        } else {
            this.selected_rows[address] = row.contact;
            row.selected = true;
            this._selectedRows.set(address, row);
        }

        this.search_entry.text = '';
        this.list.select_row(null);
        this._updateSelectionState();
    }

    _onConfirmSelection() {
        if (Object.keys(this.selected_rows).length > 0)
            this.emit('selection-confirmed');
    }

    _onSelectionModeToggled(button) {
        this.selection_mode = button.active ? 'multiple' : 'single';
    }

    clearSelection() {
        this.selected_rows = {};

        for (const row of this._selectedRows.values())
            row.selected = false;

        this._selectedRows.clear();
        this._updateSelectionState();
    }

    _updateSelectionState() {
        if (this.confirm_button === undefined)
            return;

        const count = Object.keys(this.selected_rows ?? {}).length;

        this.selection_mode_button.visible = this.show_selection_mode_button;
        this.selection_mode_button.active = this.selection_mode === 'multiple';
        this.selection_bar.visible = this.selection_mode === 'multiple';
        this.confirm_button.sensitive = count > 0;
        this.confirm_button.tooltip_text = ngettext(
            'Start conversation with %d recipient',
            'Start conversation with %d recipients',
            count
        ).format(count);

        this.selection_label.visible = this.selection_mode === 'multiple' &&
            count > 0;
        this.selection_label.label = ngettext(
            '%d selected',
            '%d selected',
            count
        ).format(count);
    }

    _filter(row) {
        // Dynamic contact always shown
        if (row.__tmp)
            return true;

        const query = this.search_entry.text;

        // Show contact if text is substring of name
        const queryName = query.toLocaleLowerCase();

        if (row.contact.name.toLocaleLowerCase().includes(queryName))
            return true;

        // Show contact if text is substring of number
        const queryNumber = normalizePhoneNumber(query);

        if (queryNumber.length) {
            for (const number of row.contact.numbers) {
                if (normalizePhoneNumber(number.value).includes(queryNumber))
                    return true;
            }

        // Query is effectively empty
        } else if (/^0+/.test(query)) {
            return true;
        }

        return false;
    }

    _sort(row1, row2) {
        if (row1.__tmp)
            return -1;

        if (row2.__tmp)
            return 1;

        return row1.contact.name.localeCompare(row2.contact.name);
    }

    _populate() {
        // Add each contact
        const contacts = this.store.contacts;

        for (let i = 0, len = contacts.length; i < len; i++)
            this._addContact(contacts[i]);
    }

    _addContactNumber(contact, index) {
        const row = new AddressRow(contact, index);
        row.connect('activated', this._onNumberSelected.bind(this));
        this.list.append(row);
        this.row_list.push(row);
        return row;
    }

    _addContact(contact) {
        try {
            // HACK: fix missing contact names
            if (contact.name === undefined)
                contact.name = _('Unknown Contact');

            const numbers = new Set();

            for (let i = 0, len = contact.numbers.length; i < len; i++) {
                const number = contact.numbers[i].value.toPhoneNumber();

                if (numbers.has(number))
                    continue;

                numbers.add(number);
                this._addContactNumber(contact, i);
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Get a dictionary of number-contact pairs for each selected phone number.
     *
     * @returns {object[]} A dictionary of contacts
     */
    getSelected() {
        try {
            return {...this.selected_rows};
        } catch (e) {
            logError(e);
            return {};
        }
    }
});
