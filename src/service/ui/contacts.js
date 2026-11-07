// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';


const _avatarTextures = new Map();


/**
 * Show a contact's name and, if there is one, photo in an avatar.
 *
 * @param {Adw.Avatar} avatar - The avatar widget
 * @param {object} [contact] - A contact object
 * @param {string} [text] - The text for initials, if not the contact's name
 */
export function setAvatarContact(avatar, contact, text = null) {
    avatar.text = text ?? contact?.name ?? '';

    const path = contact?.avatar;
    let texture = null;

    if (path) {
        texture = _avatarTextures.get(path);

        if (texture === undefined) {
            try {
                texture = Gdk.Texture.new_from_filename(path);
            } catch (e) {
                debug(e, path);
                texture = null;
            }

            _avatarTextures.set(path, texture);
        }
    }

    avatar.custom_image = texture;
}

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
        if (address?.equalsPhoneNumber(contactNumber.value))
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
            setAvatarContact(this.avatar, contact);
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
    },
    Signals: {
        'number-selected': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING],
        },
    },
    Template: 'resource:///org/gnome/Shell/Extensions/GSConnect/ui/contact-chooser.ui',
    Children: [
        'button-search', 'search-bar', 'search-entry',
        'scrolled', 'list', 'header-bar',

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
                    // TRANSLATORS: A phone number (eg. "Send to 555-5555")
                    name: _('Send to %s').format(entry.text),
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
                dynamic.title = _('Send to %s').format(address);
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
        const queryNumber = query.toPhoneNumber();

        if (queryNumber.length) {
            for (const number of row.contact.numbers) {
                if (number.value.toPhoneNumber().includes(queryNumber))
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
            return this.selected_rows;
        } catch (e) {
            logError(e);
            return {};
        }
    }
});


/**
 * Find the GNOME Contacts application, if installed.
 *
 * @returns {string[]|null} The command line to run it, or %null
 */
function getGnomeContactsCommand() {
    const appInfo = Gio.DesktopAppInfo.new('org.gnome.Contacts.desktop');

    if (appInfo === null)
        return null;

    if (appInfo.has_key('X-Flatpak')) {
        const flatpak = GLib.find_program_in_path('flatpak');

        if (flatpak !== null)
            return [flatpak, 'run', 'org.gnome.Contacts'];
    }

    const path = GLib.find_program_in_path('gnome-contacts');

    return path !== null ? [path] : null;
}


/**
 * A dialog with the details of a contact, offering to install GNOME Contacts.
 */
const ContactDialog = GObject.registerClass({
    GTypeName: 'GSConnectContactDialog',
}, class ContactDialog extends Adw.Dialog {

    _init(params) {
        super._init({
            title: params.contact.name,
            content_width: 400,
        });

        this.device = params.device;
        this.contact = params.contact;

        this._toasts = new Adw.ToastOverlay();

        const page = new Adw.PreferencesPage();
        this._toasts.child = page;

        const toolbar = new Adw.ToolbarView({content: this._toasts});
        toolbar.add_top_bar(new Adw.HeaderBar());
        this.child = toolbar;

        // Avatar and name
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            halign: Gtk.Align.CENTER,
        });
        const avatar = new Adw.Avatar({size: 96, show_initials: true});
        setAvatarContact(avatar, this.contact);
        header.append(avatar);
        header.append(new Gtk.Label({
            label: this.contact.name,
            css_classes: ['title-1'],
            wrap: true,
            justify: Gtk.Justification.CENTER,
        }));

        const headerGroup = new Adw.PreferencesGroup();
        headerGroup.add(header);
        page.add(headerGroup);

        // Phone numbers
        const numbers = new Adw.PreferencesGroup({title: _('Phone Numbers')});

        for (const number of this.contact.numbers)
            numbers.add(this._createNumberRow(number));

        page.add(numbers);

        // Suggest GNOME Contacts
        const suggestion = new Adw.PreferencesGroup();
        const row = new Adw.ActionRow({
            title: _('GNOME Contacts'),
            subtitle: _('Install GNOME Contacts to open contacts from your address book'),
        });
        row.add_prefix(new Gtk.Image({
            icon_name: 'x-office-address-book-symbolic',
        }));

        const install = new Gtk.Button({
            label: _('Install'),
            valign: Gtk.Align.CENTER,
        });
        install.connect('clicked', this._onInstall.bind(this));
        row.add_suffix(install);
        suggestion.add(row);
        page.add(suggestion);
    }

    _createNumberRow(number) {
        const row = new Adw.ActionRow({
            title: GLib.markup_escape_text(number.value, -1),
            subtitle: getNumberTypeLabel(number.type),
            subtitle_selectable: false,
            title_selectable: true,
        });

        const copy = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: _('Copy'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        copy.connect('clicked', () => {
            this.get_clipboard().set(number.value);
            this._toasts.add_toast(new Adw.Toast({title: _('Copied')}));
        });
        row.add_suffix(copy);

        const message = new Gtk.Button({
            icon_name: 'chat-bubbles-text-symbolic',
            tooltip_text: _('Send Message'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        message.connect('clicked', () => {
            this.device.activate_action('uriSms',
                new GLib.Variant('s', `sms:${number.value}`));
            this.close();
        });
        row.add_suffix(message);

        return row;
    }

    _onInstall() {
        const launcher = new Gtk.UriLauncher({uri: 'appstream://org.gnome.Contacts'});

        launcher.launch(this.get_root(), null, (obj, res) => {
            try {
                launcher.launch_finish(res);
            } catch (e) {
                debug(e);
                this._toasts.add_toast(new Adw.Toast({
                    // TRANSLATORS: Shown when no software center can install
                    // GNOME Contacts
                    title: _('Install the gnome-contacts package'),
                    timeout: 0,
                }));
            }
        });
    }
});


/**
 * Show a contact: in GNOME Contacts if it is installed, otherwise in a dialog.
 *
 * @param {Gtk.Widget} parent - The widget to present the dialog for
 * @param {Gio.ActionGroup} device - The device the contact belongs to
 * @param {object} contact - A contact object
 * @param {string} [address] - The phone number the contact was found by
 */
export function showContact(parent, device, contact, address = null) {
    const command = getGnomeContactsCommand();

    if (command !== null) {
        // Contacts from the phone have no ID in the address book, so search
        // by name, or by number for unknown contacts
        const query = contact.origin === 'gsconnect'
            ? (address ?? contact.numbers[0]?.value ?? contact.name)
            : contact.name;

        try {
            Gio.Subprocess.new([...command, '--search', query],
                Gio.SubprocessFlags.NONE);
            return;
        } catch (e) {
            debug(e, 'Launching GNOME Contacts');
        }
    }

    const dialog = new ContactDialog({device, contact});
    dialog.present(parent);
}
