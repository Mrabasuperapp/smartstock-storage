import {createRemoteJWKSet, jwtVerify} from "jose";
import {normalizeEmail, validEmail} from "./admins.mjs";

/**
 * Google sign-in through Firebase Authentication, the same project the bfast cloud console uses.
 * The browser signs in with the Firebase web SDK and sends the resulting ID token here; we verify it
 * against Google's published keys and only accept verified Google accounts.
 */
export const defaultFirebaseConfig = {
    projectId: "bfastapp",
    appId: "1:311831913786:web:6be76738b599546b",
    apiKey: "AIzaSyBNnvwleeyFislflOkB-6RFNvo7w1FI3ko",
    authDomain: "bfastapp.firebaseapp.com",
    messagingSenderId: "311831913786"
};

export function firebaseWebConfig() {
    const raw = `${process.env.FIREBASE_WEB_CONFIG ?? ""}`.trim();
    if (!raw) {
        return defaultFirebaseConfig;
    }
    const config = JSON.parse(raw);
    for (const key of ["projectId", "apiKey", "authDomain", "appId"]) {
        if (typeof config[key] !== "string") {
            throw new Error(`FIREBASE_WEB_CONFIG needs ${key}`);
        }
    }
    return config;
}

const httpError = (status, message) => Object.assign(new Error(message), {status});
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

export function createFirebaseVerifier(projectId, jwks = createRemoteJWKSet(new URL(JWKS_URL))) {
    return async idToken => {
        if (typeof idToken !== "string" || idToken.length > 4096) {
            throw httpError(401, "Sign in with Google first");
        }
        let payload;
        try {
            ({payload} = await jwtVerify(idToken, jwks, {
                algorithms: ["RS256"],
                issuer: `https://securetoken.google.com/${projectId}`,
                audience: projectId
            }));
        } catch (_) {
            throw httpError(401, "Google sign-in could not be verified. Sign in again.");
        }
        const email = normalizeEmail(payload.email);
        if (!payload.sub || payload.firebase?.sign_in_provider !== "google.com" || !validEmail(email) || payload.email_verified !== true) {
            throw httpError(401, "Only verified Google accounts can sign in");
        }
        return {
            email,
            name: typeof payload.name === "string" ? payload.name.slice(0, 120) : email,
            picture: typeof payload.picture === "string" && payload.picture.startsWith("https://") ? payload.picture : undefined
        };
    };
}

let defaultVerifier;
export const verifyGoogleIdToken = idToken => {
    defaultVerifier ??= createFirebaseVerifier(firebaseWebConfig().projectId);
    return defaultVerifier(idToken);
};
