import "./shim";
import { installWebviewPolyfill } from "./webview";
import { loadServers } from "./servers";

export async function bootIOS() {
  installWebviewPolyfill();
  await loadServers();
}
