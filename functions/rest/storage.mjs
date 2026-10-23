import {consolePage, landingPage, uiCss, uiJs, uiLandingJs, uiThemeJs} from "../../src/controllers/ui.mjs";
import {storeLog, storeRebuildIndex, storeStats, storeVerify} from "../../src/controllers/store_admin.mjs";
import {
    adminDashboard,
    adminDeleteFile,
    adminImportFiles,
    adminListHeliaDatastore,
    adminListFiles,
    handleGetFileByCid,
    handleGetFile,
    multipartForm
} from "../../src/controllers/storage.mjs";
import {
    authCreateSession,
    authDestroySession,
    authIssueToken,
    authIssueWriteToken,
    authListTokens,
    authRevokeToken,
    authLoginPage,
    authPublicKey,
    authWhoAmI,
    authorize
} from "../../src/controllers/auth.mjs";

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

export const getFileByCidREST = {
    path: `/storage/:cid`,
    method: 'GET',
    onRequest: handleGetFileByCid()
}
export const uploadFileUIREST = {
    path: `/storage`,
    method: 'GET',
    onRequest: [
        authorize({
            roles: ["admin", "uploader", "service"],
            scopes: ["storage:write"]
        }),
        (request, response) => {
            response.writeHead(200, {'content-type': 'text/html'});
            response.end(`
                <h2>With Node.js <code>"http"</code> module</h2>
                <form action="/storage" enctype="multipart/form-data" method="post">
                  <div>File: <input type="file" name="multipleFiles" multiple="multiple" /></div>
                  <input type="submit" value="Upload" />
                </form>
            `);
        }
    ]
}

export const authLoginPageREST = {
    path: `/auth/login`,
    method: 'GET',
    onRequest: authLoginPage()
}

export const authTokenREST = {
    path: `/auth/token`,
    method: 'POST',
    onRequest: authIssueToken()
}

export const authSessionCreateREST = {
    path: `/auth/session`,
    method: 'POST',
    onRequest: authCreateSession()
}

export const authSessionDestroyREST = {
    path: `/auth/session`,
    method: 'DELETE',
    onRequest: authDestroySession()
}

export const authMeREST = {
    path: `/auth/me`,
    method: 'GET',
    onRequest: authWhoAmI()
}

export const authPublicKeyREST = {
    path: `/auth/public-key`,
    method: 'GET',
    onRequest: authPublicKey()
}

export const adminDashboardLegacyREST = {
    path: `/admin/storage/legacy`,
    method: 'GET',
    onRequest: adminDashboard()
}

export const adminListFilesREST = {
    path: `/admin/storage/files`,
    method: 'GET',
    onRequest: adminListFiles()
}

export const adminDeleteFileREST = {
    path: `/admin/storage/files/:cid`,
    method: 'DELETE',
    onRequest: adminDeleteFile()
}

export const adminImportFilesREST = {
    path: `/admin/storage/import`,
    method: 'POST',
    onRequest: adminImportFiles()
}

export const adminListHeliaDatastoreREST = {
    path: `/admin/storage/helia/datastore`,
    method: 'GET',
    onRequest: adminListHeliaDatastore()
}

export const consoleREST = {
    path: `/admin/storage`,
    method: 'GET',
    onRequest: consolePage()
}

export const consoleStoreREST = {
    path: `/admin/store`,
    method: 'GET',
    onRequest: consolePage()
}

export const uiCssREST = {
    path: `/ui/console.css`,
    method: 'GET',
    onRequest: uiCss()
}

export const uiJsREST = {
    path: `/ui/console.js`,
    method: 'GET',
    onRequest: uiJs()
}

export const adminWriteTokenREST = {
    path: `/admin/tokens`,
    method: 'POST',
    onRequest: authIssueWriteToken()
}

export const storeStatsREST = {
    path: `/admin/store/stats`,
    method: 'GET',
    onRequest: storeStats()
}

export const storeLogREST = {
    path: `/admin/store/log`,
    method: 'GET',
    onRequest: storeLog()
}

export const storeVerifyREST = {
    path: `/admin/store/verify`,
    method: 'POST',
    onRequest: storeVerify()
}

export const storeRebuildIndexREST = {
    path: `/admin/store/rebuild`,
    method: 'POST',
    onRequest: storeRebuildIndex()
}

export const rootREST = {
    path: `/`,
    method: 'GET',
    onRequest: landingPage()
}

export const uiLandingJsREST = {
    path: `/ui/landing.js`,
    method: 'GET',
    onRequest: uiLandingJs()
}

export const adminListTokensREST = {
    path: `/admin/tokens`,
    method: 'GET',
    onRequest: authListTokens()
}

export const adminRevokeTokenREST = {
    path: `/admin/tokens/:id`,
    method: 'DELETE',
    onRequest: authRevokeToken()
}

export const uiThemeJsREST = {
    path: `/ui/theme.js`,
    method: 'GET',
    onRequest: uiThemeJs()
}
