# Persistent Qoder and TRAE login and title bar repair

The user approved persistent login in the existing `codex/dark-liquid-glass` branch. Qoder uses a user-created China-region PAT; TRAE uses an app-owned web login session where available. Secrets live in Windows Credential Manager under QuotaHalo-specific names. They are never sent to the front end after saving. The settings panel offers connect, connected state, and forget actions.

On launch, Rust reads stored credentials and refreshes the credit rows. Qoder exchanges the PAT for a short-lived job token before using the existing bearer credit endpoint, repeating the exchange after expiration. TRAE opens a separate login window, saves the long-lived session, and renews a short-lived access token when required. Failed or expired authentication is shown as a reconnect state, while transient network errors retain credentials. Manual credentials remain a fallback where login-site behavior prevents session capture.

The main popup stays undecorated. Its header receives a denser dark background so an underlying native title bar cannot show through the glass. The auth window has normal system decorations and is visually separate from the popup.

Validation: unit tests for parsing and state transitions, frontend lifecycle test, release build, and visual check of the popup header and auth controls. No credentials or raw responses are logged or committed.
