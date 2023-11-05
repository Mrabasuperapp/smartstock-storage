import {handleGetFile, multipartForm} from "../../src/controllers/storage.mjs";

export const uploadMultipart = {
    path: `/storage`,
    method: 'POST',
    onRequest: multipartForm()
}

export const uploadMultipartV2 = {
    path: `/shop/:pid/:aid/storage`,
    method: 'POST',
    onRequest: multipartForm()
}

export const getFileREST = {
    path: `/storage/:cid/:filename`,
    method: 'GET',
    onRequest: handleGetFile()
}
export const uploadFileUIREST = {
    path: `/storage`,
    method: 'GET',
    onRequest: (request, response) => {
        response.writeHead(200, {'content-type': 'text/html'});
        response.end(`
                <h2>With Node.js <code>"http"</code> module</h2>
                <form action="/storage" enctype="multipart/form-data" method="post">
                  <div>File: <input type="file" name="multipleFiles" multiple="multiple" /></div>
                  <input type="submit" value="Upload" />
                </form>
            `);
    }
}