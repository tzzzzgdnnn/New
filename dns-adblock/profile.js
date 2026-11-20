// The iOS configuration profile (com.apple.dnsSettings.managed) that points the
// device's DNS at the Super Player ad-block DoH endpoint. Unsigned.
// UUIDs are fixed so reinstalling replaces the profile instead of adding one.
export const PROFILE_UUID = "13078AB6-0988-5AD4-89E8-75D06AC1DB26"; // same as the shipped AdGuard profile, so an upgrade replaces it
export const PAYLOAD_UUID = "FAEB2827-8BCE-508F-A6F5-60E9F95D5843";
export const PROFILE_IDENTIFIER = "com.superplayer.dnsadblock";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** @param {string} serverUrl e.g. https://superplayer-dns.example.workers.dev/dns-query */
export function buildMobileconfig(serverUrl) {
  if (!/^https:\/\/[^\s/]+\/\S*$/.test(serverUrl)) throw new Error(`Bad DoH ServerURL: ${serverUrl}`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>DNSSettings</key>
			<dict>
				<key>DNSProtocol</key>
				<string>HTTPS</string>
				<key>ServerURL</key>
				<string>${esc(serverUrl)}</string>
			</dict>
			<key>PayloadDescription</key>
			<string>Blocks the ad and pop-up domains Super Player knows about, on this device.</string>
			<key>PayloadDisplayName</key>
			<string>Super Player Ad Block</string>
			<key>PayloadIdentifier</key>
			<string>${PROFILE_IDENTIFIER}.dns</string>
			<key>PayloadType</key>
			<string>com.apple.dnsSettings.managed</string>
			<key>PayloadUUID</key>
			<string>${PAYLOAD_UUID}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>PayloadDescription</key>
	<string>Encrypted DNS (DNS over HTTPS) that blocks ad and pop-up domains while you use Super Player and other sites.</string>
	<key>PayloadDisplayName</key>
	<string>Super Player Ad Block</string>
	<key>PayloadIdentifier</key>
	<string>${PROFILE_IDENTIFIER}</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>${PROFILE_UUID}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`;
}
