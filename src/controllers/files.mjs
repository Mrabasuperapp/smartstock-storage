import {generateCidFromBuffer, generateCidFromDataStream, generateDataFromCid, getFileSizeFromCid} from "./ipfs.mjs";
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
 * @param file {{cid: string, start?: number, end?: number}} start and end are inclusive byte offsets
 * @return {Promise<ReadableStream>}
 */
export async function getFileStream({cid, start, end}) {
    if (cid) {
        return await generateDataFromCid(
            cid, {stream: true, start, end}
        );
    } else {
        throw new Error("file not found, maybe it is deleted");
    }
}

/**
 * @param file {{cid: string}}
 * @return {Promise<number>}
 */
export async function getFileSize({cid}) {
    if (!cid) {
        throw new Error("file not found, maybe it is deleted");
    }
    return await getFileSizeFromCid(cid);
}
