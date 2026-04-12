// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import Config from '../../config.js';
import { parsePhoneNumberFromString } from '../../vendor/libphonenumber-esm.js';

let _settings = null;
let _defaultCountry = null;

function getDefaultCountry() {
    if (_defaultCountry) return _defaultCountry;

    let country = '';

    try {
        if (!_settings) {
            _settings = new Gio.Settings({
                settings_schema: Config.GSCHEMA.lookup('org.gnome.Shell.Extensions.GSConnect', true)
            });
            _settings.connect('changed::default-country', () => {
                _defaultCountry = null;
            });
        }
        country = _settings.get_string('default-country');
    } catch (e) { }

    if (!country) {
        try {
            const locale = Intl.DateTimeFormat().resolvedOptions().locale;
            if (locale && locale.includes('-')) {
                country = locale.split('-')[1].toUpperCase();
            }
        } catch (e) { }

        if (!country) country = 'US';

        try {
            if (_settings) _settings.set_string('default-country', country);
        } catch (e) { }
    }

    _defaultCountry = country;
    return country;
}

export function parsePhoneNumber(string, country = getDefaultCountry()) {
    if (!string) return { number: '' };
    const parsed = parsePhoneNumberFromString(string, country);
    return parsed || { number: string };
}
