import * as uuid from 'uuid';

/**
 *
 * @return {string}
 */
export function generateUUID() {
    return uuid.v4();
}

// export function sha256OfObject(data: { [key: string]: any }) {
//     return createHash('sha256')
//         .update(JSON.stringify(data))
//         .digest('hex');
// }