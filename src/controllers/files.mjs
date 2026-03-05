import {generateCidFromBuffer, generateCidFromDataStream, generateDataFromCid} from "./ipfs.mjs";
import {devLog} from "../utils/debug.mjs";

/**
 *
 * @param name{string}
 * @param size {number}
 * @param data {ReadableStream}
 * @param contentType {string}
 * @return {Promise<Storage>}
 */
export async function createFileFromStream(
    name, size, data, contentType
) {
    devLog('WRITE FILE')
    const dataRes = await generateCidFromDataStream({
        data,
        size,
        name,
        type: contentType
    });
    return getFileLocation(dataRes.cid, name);
}

/**
 *
 * @param name{string}
 * @param size {number}
 * @param data {Buffer}
 * @param contentType {string}
 * @return {Promise<Storage>}
 */
export async function createFileFromBuffer(
    name, size, data, contentType
) {
    devLog('WRITE FILE')
    const dataRes = await generateCidFromBuffer({
        data,
        size,
        name,
        type: contentType
    });
    return getFileLocation(dataRes.cid, name);
}


/**
 *
 * @param cid {string}
 * @param filename {string}
 * @return {Promise<string>}
 */
export async function getFileLocation(cid, filename) {
    return `/storage/${encodeURIComponent(cid)}/${encodeURIComponent(filename)}`;
}

/**
 *
 * @param file {{cid: string}}
 * @return {Promise<Buffer>}
 */
export async function getFileBuffer({cid}) {
    if (cid) {
        return await generateDataFromCid(
            cid, {json: false, stream: false}
        );
    } else {
        throw new Error("file not found, maybe it is deleted");
    }
}

/**
 *
 * @param file {{cid: string}}
 * @return {Promise<ReadableStream>}
 */
export async function getFileStream({cid}) {
    if (cid) {
        return await generateDataFromCid(
            cid, {stream: true}
        );
    } else {
        throw new Error("file not found, maybe it is deleted");
    }
}
