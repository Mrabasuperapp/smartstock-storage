import {debuglog} from 'util'

const log = debuglog('dev');
const logP = debuglog('prod');
const isProd = `${process.env.NODE_ENV ?? ""}`.toLowerCase() === "production";

/**
 *
 * @param message{string}
 * @param args{*}
 */
export function devLog(message, ...args) {
    if (!isProd) {
        log(message, ...args);
    }
}

/**
 *
 * @param message {string}
 * @param args{*}
 */
export function prodLog(message, ...args) {
    logP(message, ...args);
}
