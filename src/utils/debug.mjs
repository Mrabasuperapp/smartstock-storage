import {debuglog} from 'util'

const log = debuglog('dev');
const logP = debuglog('prod');

/**
 *
 * @param message{string}
 * @param args{*}
 */
export function devLog(message, ...args) {
    // log(message, args);
    console.log(message,args);
}

/**
 *
 * @param message {string}
 * @param args{*}
 */
export function prodLog(message, ...args) {
    logP(message, args);
}