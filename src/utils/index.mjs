import {validate} from "jsonschema";

/**
 *
 * @param data {*}
 * @param schema {*}
 * @param message {string}
 * @returns {Promise<boolean>}
 */
export async function validateInput(data, schema, message) {
    // @ts-ignore
    const a = validate(data, schema, {required: true});
    if (a.valid===false){
        throw {message, reason: a.errors.map(e=>`${e.message}`).join(', ')}
    }
    return true
}