import "./shim";
import { installWebviewPolyfill } from "./webview";
import { loadServers } from "./servers";

export async function bootIOS() {
  installWebviewPolyfill();
  loadServers(); // cached copy applies synchronously; the refresh is not awaited
}
