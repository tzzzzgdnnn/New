import "./shim";
import { installWebviewPolyfill } from "./webview";
import { loadServers } from "./servers";
import { restoreCustomServers } from "./customServers";
import { diag } from "../../utils/diag";

export async function bootIOS() {
  installWebviewPolyfill();
  loadServers(); // cached copy applies synchronously; the refresh is not awaited
  // Custom servers lost from localStorage come back from the Keychain copy.
  restoreCustomServers().catch((e) => diag("custom", `restore failed: ${e?.message || e}`));
}
