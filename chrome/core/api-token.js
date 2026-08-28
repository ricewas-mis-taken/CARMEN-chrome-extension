// Shared local-pairing token for authenticating to the desktop app's API
// (see carmen-desktop's api_server.py _require_token -- every state-changing
// endpoint now requires this). The desktop app generates it; the user copies
// it once (tray menu -> "Copy API Token") and pastes it into this browser's
// popup, which stores it here. From then on it's attached as the
// X-Carmen-Token header on every mutating request this extension makes.
//
// Deliberately NOT fetched from the desktop API itself -- an unauthenticated
// endpoint that hands out the auth token would defeat the point of requiring
// one. Pairing is a one-time manual step, once per browser profile the
// extension is installed in.
export const API_TOKEN_KEY = "carmenApiToken";

export async function getApiToken(storageApi) {
  const result = await storageApi.get(API_TOKEN_KEY);
  return result[API_TOKEN_KEY] || "";
}

export async function setApiToken(storageApi, token) {
  await storageApi.set({ [API_TOKEN_KEY]: (token || "").trim() });
}
