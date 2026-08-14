// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import GIRepository from 'gi://GIRepository';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import Config from '../../config.js';

const Tweener = imports.tweener.tweener;


let Gvc = null;
try {
    // Add gnome-shell's typelib dir to the search path
    const typelibDir = GLib.build_filenamev([Config.GNOME_SHELL_LIBDIR, 'gnome-shell']);

    if (GIRepository.Repository.hasOwnProperty('prepend_search_path')) {
        // GNOME <= 48 / GIRepository 2.0
        GIRepository.Repository.prepend_search_path(typelibDir);
        GIRepository.Repository.prepend_library_path(typelibDir);
    } else {
        // GNOME 49+ / GIRepository 3.0
        const repo = GIRepository.Repository.dup_default();
        repo.prepend_search_path(typelibDir);
        repo.prepend_library_path(typelibDir);
    }

    Gvc = (await import('gi://Gvc')).default;
} catch {}


/**
 * Extend Gvc.MixerStream with a property for returning a user-visible name
 */
if (Gvc) {
    Object.defineProperty(Gvc.MixerStream.prototype, 'display_name', {
        get: function () {
            try {
                if (!this.get_ports().length)
                    return this.description;

                return `${this.get_port().human_port} (${this.description})`;
            } catch {
                return this.description;
            }
        },
    });
}


/**
 * A convenience wrapper for Gvc.MixerStream
 */
class Stream {
    constructor(mixer, stream) {
        this._mixer = mixer;
        this._stream = stream;

        this._max = mixer.get_vol_max_norm();
    }

    get muted() {
        return this._stream.is_muted;
    }

    set muted(bool) {
        this._stream.change_is_muted(bool);
    }

    get id() {
        return this._stream.id;
    }

    // Volume is a double in the range 0-1
    get volume() {
        return Math.floor(100 * this._stream.volume / this._max) / 100;
    }

    set volume(num) {
        this._stream.volume = Math.floor(num * this._max);
        this._stream.push_volume();
    }

    /**
     * Gradually raise or lower the stream volume to {@link value}
     *
     * @param {number} value - A number in the range 0-1
     * @param {number} [duration] - Duration to fade in seconds
     */
    fade(value, duration = 1) {
        Tweener.removeTweens(this);

        if (this._stream.volume > value) {
            this._mixer.fading = true;

            Tweener.addTween(this, {
                volume: value,
                time: duration,
                transition: 'easeOutCubic',
                onComplete: () => {
                    this._mixer.fading = false;
                },
            });
        } else if (this._stream.volume < value) {
            this._mixer.fading = true;

            Tweener.addTween(this, {
                volume: value,
                time: duration,
                transition: 'easeInCubic',
                onComplete: () => {
                    this._mixer.fading = false;
                },
            });
        }
    }
}


/**
 * A subclass of Gvc.MixerControl with convenience functions for controlling the
 * default input/output volumes.
 *
 * The Mixer class uses GNOME Shell's Gvc library to control the system volume
 * and offers a few convenience functions.
 */
const Mixer = !Gvc ? null : GObject.registerClass({
    GTypeName: 'GSConnectAudioMixer',
}, class Mixer extends Gvc.MixerControl {
    _init(params) {
        super._init({name: 'GSConnect'});

        this._previousVolume = undefined;
        this._previousApplicationVolumes = new Map();
        this._applicationVolumeMuted = new Set();
        this._applicationMicrophoneMuted = new Set();
        this._volumeMuted = false;
        this._microphoneMuted = false;

        this.open();
    }

    get fading() {
        if (this._fading === undefined)
            this._fading = false;

        return this._fading;
    }

    set fading(bool) {
        if (this.fading === bool)
            return;

        this._fading = bool;

        if (this.fading)
            this.emit('stream-changed', this._output._stream.id);
    }

    get input() {
        if (this._input === undefined)
            this.vfunc_default_source_changed();

        return this._input;
    }

    get output() {
        if (this._output === undefined)
            this.vfunc_default_sink_changed();

        return this._output;
    }

    vfunc_default_sink_changed(id) {
        try {
            const sink = this.get_default_sink();
            this._output = (sink) ? new Stream(this, sink) : null;
        } catch (e) {
            logError(e);
        }
    }

    vfunc_default_source_changed(id) {
        try {
            const source = this.get_default_source();
            this._input = (source) ? new Stream(this, source) : null;
        } catch (e) {
            logError(e);
        }
    }

    vfunc_state_changed(new_state) {
        try {
            if (new_state === Gvc.MixerControlState.READY) {
                this.vfunc_default_sink_changed(null);
                this.vfunc_default_source_changed(null);
            }
        } catch (e) {
            logError(e);
        }
    }

    _isCallStream(stream) {
        const streamId = [
            stream.get_application_id?.(),
            stream.get_application_name?.(),
            stream.get_name?.(),
            stream.get_description?.(),
            stream.application_id,
            stream.name,
            stream.description,
        ].filter(value => value !== undefined && value !== null)
            .join(' ')
            .toLowerCase();

        return streamId.includes('bluez') ||
            streamId.includes('bluetooth') ||
            streamId.includes('hfp') ||
            streamId.includes('hsp') ||
            streamId.includes('handsfree') ||
            streamId.includes('hands-free') ||
            streamId.includes('headset') ||
            streamId.includes('ofono') ||
            streamId.includes('phone') ||
            streamId.includes('telephony');
    }

    _isApplicationStream(stream) {
        return stream !== null &&
            !stream.is_event_stream &&
            !stream.is_virtual &&
            !this._isCallStream(stream);
    }

    _getSinkInputs() {
        return this.get_sink_inputs()
            .filter(stream => this._isApplicationStream(stream))
            .map(stream => new Stream(this, stream));
    }

    _getSourceOutputs() {
        return this.get_source_outputs()
            .filter(stream => this._isApplicationStream(stream))
            .map(stream => new Stream(this, stream));
    }

    _getCallOutputStreams() {
        return (this.get_sink_inputs?.() ?? [])
            .filter(stream => this._isCallStream(stream))
            .map(stream => new Stream(this, stream));
    }

    /**
     * Restore audible playback on Bluetooth call streams without changing
     * global devices, microphones or unrelated application streams.
     */
    unmuteCallOutputStreams() {
        try {
            for (const stream of this._getCallOutputStreams()) {
                if (stream.muted)
                    stream.muted = false;

                if (stream.volume < 0.75)
                    stream.volume = 1.0;
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Store the current output volume then lower it to %15
     *
     * @param {number} duration - Duration in seconds to fade
     */
    lowerVolume(duration = 1) {
        try {
            if (this.output && this.output.volume > 0.15) {
                this._previousVolume = Number(this.output.volume);
                this.output.fade(0.15, duration);
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Store current application output volumes then lower them to %15.
     *
     * @param {number} duration - Duration in seconds to fade
     */
    lowerApplicationVolumes(duration = 1) {
        try {
            for (const stream of this._getSinkInputs()) {
                if (stream.volume <= 0.15)
                    continue;

                this._previousApplicationVolumes.set(stream.id, Number(stream.volume));
                stream.fade(0.15, duration);
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Mute the output volume (speakers)
     */
    muteVolume() {
        try {
            if (!this.output || this.output.muted)
                return;

            this.output.muted = true;
            this._volumeMuted = true;
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Mute application output streams.
     */
    muteApplicationVolumes() {
        try {
            for (const stream of this._getSinkInputs()) {
                if (stream.muted)
                    continue;

                stream.muted = true;
                this._applicationVolumeMuted.add(stream.id);
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Mute the input volume (microphone)
     */
    muteMicrophone() {
        try {
            if (!this.input || this.input.muted)
                return;

            this.input.muted = true;
            this._microphoneMuted = true;
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Mute application recording streams without muting the input device.
     */
    muteApplicationMicrophones() {
        try {
            for (const stream of this._getSourceOutputs()) {
                if (stream.muted)
                    continue;

                stream.muted = true;
                this._applicationMicrophoneMuted.add(stream.id);
            }
        } catch (e) {
            logError(e);
        }
    }

    /**
     * Restore all mixer levels to their previous state
     */
    restore() {
        try {
            // If we muted the microphone, unmute it before restoring the volume
            if (this._microphoneMuted) {
                this.input.muted = false;
                this._microphoneMuted = false;
            }

            // If we muted the volume, unmute it before restoring the volume
            if (this._volumeMuted) {
                this.output.muted = false;
                this._volumeMuted = false;
            }

            // If a previous volume is defined, raise it back up to that level
            if (this._previousVolume !== undefined) {
                this.output.fade(this._previousVolume);
                this._previousVolume = undefined;
            }

            for (const stream of this._getSinkInputs()) {
                if (this._applicationVolumeMuted.has(stream.id))
                    stream.muted = false;

                if (this._previousApplicationVolumes.has(stream.id)) {
                    stream.fade(this._previousApplicationVolumes.get(
                        stream.id));
                }
            }

            for (const stream of this._getSourceOutputs()) {
                if (this._applicationMicrophoneMuted.has(stream.id))
                    stream.muted = false;
            }

            this._applicationVolumeMuted.clear();
            this._applicationMicrophoneMuted.clear();
            this._previousApplicationVolumes.clear();
        } catch (e) {
            logError(e);
        }
    }

    destroy() {
        this.close();
    }
});


/**
 * The service class for this component
 */
export default Mixer;
