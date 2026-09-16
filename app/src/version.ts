/**
 * Deployment versioning.
 *
 * `BUILD` is the patch counter — bump it on every change you deploy to
 * hardware. The full string is shown on the home screen and logged to
 * logcat at startup (`[app] version vX.Y.Z+BUILD`), so you can always
 * confirm which patch a device is actually running.
 */
export const APP_VERSION = "0.1.0";

/** Increment on every patch shipped to a device. */
export const BUILD = 20;

export const VERSION = `v${APP_VERSION}+${BUILD}`;