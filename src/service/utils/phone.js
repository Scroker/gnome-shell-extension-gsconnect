// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import Config from '../../config.js';
import {parsePhoneNumberFromString} from '../../vendor/libphonenumber-esm.js';

let _settings = null;
let _defaultCountry = null;

/**
 * Get the default country code from settings or locale fallback.
 *
 * @returns {string} The default ISO country code.
 */
function getDefaultCountry() {
    if (_defaultCountry)
        return _defaultCountry;

    let country = '';

    try {
        if (!_settings) {
            _settings = new Gio.Settings({
                settings_schema: Config.GSCHEMA.lookup('org.gnome.Shell.Extensions.GSConnect', true),
            });
            _settings.connect('changed::default-country', () => {
                _defaultCountry = null;
            });
        }
        country = _settings.get_string('default-country');
    } catch (e) {
        console.error('Error accessing settings for default country:', e);
    }

    if (!country) {
        try {
            const locale = Intl.DateTimeFormat().resolvedOptions().locale;
            if (locale?.includes('-'))
                country = locale.split('-')[1].toUpperCase();

        } catch (e) {
            console.error('Error determining locale for default country:', e);
        }

        if (!country)
            country = 'US';

        try {
            if (_settings)
                _settings.set_string('default-country', country);
        } catch (e) {
            console.error('Error setting default country:', e);
        }
    }

    _defaultCountry = country;
    return country;
}

/**
 * Parse a phone number string using the given country code.
 *
 * @param {string} string - The phone number to parse.
 * @param {string} country - The country code to use for parsing.
 * @returns {{number: string}} The parsed phone number object, or a fallback object.
 */
export function parsePhoneNumber(string, country = getDefaultCountry()) {
    if (!string)
        return {number: ''};
    const parsed = parsePhoneNumberFromString(string, country);
    return parsed || {number: string};
}
