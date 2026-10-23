import {teamAdd, teamList, teamRemove} from "../../src/controllers/team.mjs";
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
    authFirebaseConfig,
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
export const landingStorageREST = {
    path: `/storage`,
    method: 'GET',
    onRequest: landingPage()
}

export const authLoginPageREST = {
    path: `/storage/auth/login`,
    method: 'GET',
    onRequest: authLoginPage()
}

export const authTokenREST = {
    path: `/storage/auth/token`,
    method: 'POST',
    onRequest: authIssueToken()
}

export const authSessionCreateREST = {
    path: `/storage/auth/session`,
    method: 'POST',
    onRequest: authCreateSession()
}

export const authSessionDestroyREST = {
    path: `/storage/auth/session`,
    method: 'DELETE',
    onRequest: authDestroySession()
}

export const authMeREST = {
    path: `/storage/auth/me`,
    method: 'GET',
    onRequest: authWhoAmI()
}

export const authPublicKeyREST = {
    path: `/storage/auth/public-key`,
    method: 'GET',
    onRequest: authPublicKey()
}

export const adminDashboardLegacyREST = {
    path: `/storage/admin/legacy`,
    method: 'GET',
    onRequest: adminDashboard()
}

export const adminListFilesREST = {
    path: `/storage/admin/files`,
    method: 'GET',
    onRequest: adminListFiles()
}

export const adminDeleteFileREST = {
    path: `/storage/admin/files/:cid`,
    method: 'DELETE',
    onRequest: adminDeleteFile()
}

export const adminImportFilesREST = {
    path: `/storage/admin/import`,
    method: 'POST',
    onRequest: adminImportFiles()
}

export const adminListHeliaDatastoreREST = {
    path: `/storage/admin/helia/datastore`,
    method: 'GET',
    onRequest: adminListHeliaDatastore()
}

export const consoleREST = {
    path: `/storage/admin`,
    method: 'GET',
    onRequest: consolePage()
}

export const consoleStoreREST = {
    path: `/storage/admin/store`,
    method: 'GET',
    onRequest: consolePage()
}

export const uiCssREST = {
    path: `/storage/ui/console.css`,
    method: 'GET',
    onRequest: uiCss()
}

export const uiJsREST = {
    path: `/storage/ui/console.js`,
    method: 'GET',
    onRequest: uiJs()
}

export const adminWriteTokenREST = {
    path: `/storage/admin/tokens`,
    method: 'POST',
    onRequest: authIssueWriteToken()
}

export const storeStatsREST = {
    path: `/storage/admin/store/stats`,
    method: 'GET',
    onRequest: storeStats()
}

export const storeLogREST = {
    path: `/storage/admin/store/log`,
    method: 'GET',
    onRequest: storeLog()
}

export const storeVerifyREST = {
    path: `/storage/admin/store/verify`,
    method: 'POST',
    onRequest: storeVerify()
}

export const storeRebuildIndexREST = {
    path: `/storage/admin/store/rebuild`,
    method: 'POST',
    onRequest: storeRebuildIndex()
}

export const rootREST = {
    path: `/`,
    method: 'GET',
    onRequest: landingPage()
}

export const uiLandingJsREST = {
    path: `/storage/ui/landing.js`,
    method: 'GET',
    onRequest: uiLandingJs()
}

export const adminListTokensREST = {
    path: `/storage/admin/tokens`,
    method: 'GET',
    onRequest: authListTokens()
}

export const adminRevokeTokenREST = {
    path: `/storage/admin/tokens/:id`,
    method: 'DELETE',
    onRequest: authRevokeToken()
}

export const uiThemeJsREST = {
    path: `/storage/ui/theme.js`,
    method: 'GET',
    onRequest: uiThemeJs()
}

export const authFirebaseConfigREST = {
    path: `/storage/auth/config`,
    method: 'GET',
    onRequest: authFirebaseConfig()
}

export const adminTeamListREST = {
    path: `/storage/admin/team`,
    method: 'GET',
    onRequest: teamList()
}

export const adminTeamAddREST = {
    path: `/storage/admin/team`,
    method: 'POST',
    onRequest: teamAdd()
}

export const adminTeamRemoveREST = {
    path: `/storage/admin/team/:email`,
    method: 'DELETE',
    onRequest: teamRemove()
}
