// Stand-in for firebase-app-check.js
export class ReCaptchaEnterpriseProvider { constructor(siteKey) { this.siteKey = siteKey; } }
export function initializeAppCheck(app, opts) { (globalThis.__appCheck ||= []).push({ siteKey: opts.provider.siteKey, auto: opts.isTokenAutoRefreshEnabled }); return {}; }
