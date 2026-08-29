// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';

import Config from '../../config.js';
import {parsePhoneNumberFromString} from '../../vendor/libphonenumber-esm.js';


let _settings = null;
let _defaultCountry = null;


/**
 *
 */
function _getSettings() {
    if (_settings === null) {
        _settings = new Gio.Settings({
            settings_schema: Config.GSCHEMA.lookup(
                'org.gnome.Shell.Extensions.GSConnect',
                true
            ),
        });

        _settings.connect('changed::default-country', () => {
            _defaultCountry = null;
        });
    }

    return _settings;
}

/**
 *
 */
function _getLocaleCountry() {
    try {
        const locale = Intl.DateTimeFormat().resolvedOptions().locale;
        const match = locale.match(/[-_]([A-Za-z]{2})\b/);

        if (match)
            return match[1].toUpperCase();
    } catch {
    }

    return 'US';
}

/**
 *
 */
export function getDefaultCountry() {
    if (_defaultCountry !== null)
        return _defaultCountry;

    try {
        const country = _getSettings().get_string('default-country').toUpperCase();
        _defaultCountry = country || _getLocaleCountry();
    } catch {
        _defaultCountry = _getLocaleCountry();
    }

    return _defaultCountry;
}

/**
 *
 * @param number
 * @param country
 */
export function normalizePhoneNumber(number, country = getDefaultCountry()) {
    if (!number)
        return '';

    if (typeof number !== 'string')
        number = number.number ?? `${number}`;

    let parsed = null;

    try {
        parsed = parsePhoneNumberFromString(number, country);
    } catch {
    }

    if (parsed?.number)
        return parsed.number;

    const strippedNumber = number.replace(/[ ()+-]/g, '').replace(/^0*/, '');

    return strippedNumber || number;
}

/**
 *
 * @param number
 * @param country
 */
export function parsePhoneNumber(number, country = getDefaultCountry()) {
    try {
        return parsePhoneNumberFromString(number, country) ?? {
            number: normalizePhoneNumber(number, country),
        };
    } catch {
        return {number: normalizePhoneNumber(number)};
    }
}

/**
 *
 * @param number
 * @param otherNumber
 * @param country
 */
export function phoneNumbersEqual(number, otherNumber, country = getDefaultCountry()) {
    const a = normalizePhoneNumber(number, country);
    const b = normalizePhoneNumber(otherNumber, country);

    return Boolean(a && b && (a === b || a.endsWith(b) || b.endsWith(a)));
}
